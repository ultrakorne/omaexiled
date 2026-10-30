#include "cookiewatcher.h"

#include <QDateTime>
#include <QFileInfo>
#include <QJsonObject>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QWebEngineCookieStore>

// Chromium replaces a cookie as remove + add, and a page load can set
// several at once: coalesce them into one message.
static constexpr int kDebounce = 150;

static QString identity(const QNetworkCookie &c) {
  return QString::fromUtf8(c.name()) + u'\x1f' + c.domain() + u'\x1f' + c.path();
}

CookieWatcher::CookieWatcher(QWebEngineCookieStore *store, QObject *parent)
    : QObject(parent), m_store(store) {
  m_debounce.setSingleShot(true);
  m_debounce.setInterval(kDebounce);
  connect(&m_debounce, &QTimer::timeout, this, &CookieWatcher::flush);
  connect(m_store, &QWebEngineCookieStore::cookieAdded, this, &CookieWatcher::onAdded);
  connect(m_store, &QWebEngineCookieStore::cookieRemoved, this, &CookieWatcher::onRemoved);
}

void CookieWatcher::start() {
  if (m_started) return;
  m_started = true;
  // Documented to replay every stored cookie through cookieAdded; in 6.11 it
  // replays nothing (hence seedFromDatabase), harmless if that gets fixed.
  m_store->loadAllCookies();
  m_debounce.start();
}

int CookieWatcher::seedFromDatabase(const QString &storagePath) {
  QString file;
  for (const QString &candidate : {storagePath + QStringLiteral("/Cookies"),
                                   storagePath + QStringLiteral("/Network/Cookies")}) {
    if (QFileInfo::exists(candidate)) file = candidate;
  }
  if (file.isEmpty()) return 0;

  // Chromium's cookie table (schema version 24 here). expires_utc counts
  // microseconds since 1601-01-01; values are plain text unless os_crypt is
  // in use (then only encrypted_value is set, which we can't read).
  static constexpr qint64 kWindowsToUnixSecs = 11644473600LL;
  const QString connection = QStringLiteral("omaexiled-cookies");
  int count = 0;
  {
    QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection);
    db.setDatabaseName(file);
    db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
    if (!db.open()) {
      qWarning("cannot read %s: %s", qPrintable(file), qPrintable(db.lastError().text()));
    } else {
      QSqlQuery q(db);
      if (!q.exec(QStringLiteral("SELECT host_key, name, value, path, expires_utc, is_secure, "
                                 "is_httponly, is_persistent FROM cookies"))) {
        qWarning("cannot read %s: %s", qPrintable(file), qPrintable(q.lastError().text()));
      }
      const qint64 now = QDateTime::currentSecsSinceEpoch();
      while (q.next()) {
        const QString domain = q.value(0).toString();
        const QByteArray value = q.value(2).toByteArray();
        const qint64 expires = q.value(4).toLongLong() / 1000000 - kWindowsToUnixSecs;
        if (!isWatchedDomain(domain) || value.isEmpty() || !q.value(7).toBool() || expires <= now)
          continue;
        QNetworkCookie cookie(q.value(1).toByteArray(), value);
        cookie.setDomain(domain);
        cookie.setPath(q.value(3).toString());
        cookie.setExpirationDate(QDateTime::fromSecsSinceEpoch(expires));
        cookie.setSecure(q.value(5).toBool());
        cookie.setHttpOnly(q.value(6).toBool());
        m_cookies.insert(identity(cookie), cookie);
        ++count;
      }
    }
  }
  QSqlDatabase::removeDatabase(connection);
  return count;
}

bool CookieWatcher::isWatchedDomain(const QString &domain) {
  QString d = domain.toLower();
  if (d.startsWith(u'.')) d.remove(0, 1);
  return d == u"pathofexile.com" || d.endsWith(u".pathofexile.com");
}

void CookieWatcher::onAdded(const QNetworkCookie &cookie) {
  if (!isWatchedDomain(cookie.domain())) return;
  m_cookies.insert(identity(cookie), cookie);
  if (m_started) m_debounce.start();
}

void CookieWatcher::onRemoved(const QNetworkCookie &cookie) {
  if (!isWatchedDomain(cookie.domain())) return;
  if (m_cookies.remove(identity(cookie)) && m_started) m_debounce.start();
}

QJsonArray CookieWatcher::cookies() const {
  QJsonArray list;
  for (const QNetworkCookie &c : m_cookies) {
    list.append(QJsonObject{
        {"name", QString::fromUtf8(c.name())},
        {"value", QString::fromUtf8(c.value())},
        // As Chromium reports it: ".pathofexile.com" for domain cookies,
        // "www.pathofexile.com" for host-only ones.
        {"domain", c.domain()},
        {"path", c.path().isEmpty() ? QStringLiteral("/") : c.path()},
        // Seconds since the epoch, null for session cookies.
        {"expires", c.isSessionCookie()
                        ? QJsonValue(QJsonValue::Null)
                        : QJsonValue(double(c.expirationDate().toSecsSinceEpoch()))},
        {"secure", c.isSecure()},
        {"httpOnly", c.isHttpOnly()},
    });
  }
  return list;
}

void CookieWatcher::flush() {
  const QJsonArray list = cookies();
  // Nothing to tell on startup with an empty jar, and no repeats.
  if (list == m_lastSent) return;
  m_lastSent = list;
  emit cookiesChanged(list);
}
