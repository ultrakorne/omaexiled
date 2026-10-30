#include "host.h"

#include <QCoreApplication>
#include <QDesktopServices>
#include <QJsonArray>
#include <QQmlComponent>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickWebEngineProfile>
#include <QQuickWindow>
#include <QStandardPaths>
#include <QUrlQuery>

#include "cookiewatcher.h"
#include "overlay.h"

Host::Host(const QString &socketPath, const QUrl &baseUrl, QObject *parent)
    : QObject(parent), m_link(socketPath), m_base(baseUrl) {}

Host::~Host() {
  // Pages before the engine, both before the profile (a child, deleted
  // after this body).
  for (const auto &window : std::as_const(m_devtools)) delete window.data();
  delete m_browser.data();
  delete m_settings.data();
  delete m_overlay;
  delete m_overlayWindow;
  delete m_engine;
}

bool Host::start() {
  // One persistent profile for every window: the overlay and settings pages
  // share localStorage, and the browser's pathofexile.com cookies are the
  // ones the backend proxy uses.
  const QString data = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
  const QString cache = QStandardPaths::writableLocation(QStandardPaths::GenericCacheLocation);
  m_profile = new QQuickWebEngineProfile(QStringLiteral("omaexiled"), this);
  m_profile->setPersistentStoragePath(data + QStringLiteral("/omaexiled/webengine"));
  m_profile->setCachePath(cache + QStringLiteral("/omaexiled/webengine"));
  m_profile->setHttpCacheType(QQuickWebEngineProfile::DiskHttpCache);
  m_profile->setPersistentCookiesPolicy(QQuickWebEngineProfile::AllowPersistentCookies);

  m_cookies = new CookieWatcher(m_profile->cookieStore(), this);
  if (const int n = m_cookies->seedFromDatabase(m_profile->persistentStoragePath()))
    qInfo("%d stored pathofexile.com cookies", n);
  connect(m_cookies, &CookieWatcher::cookiesChanged, this, [this](const QJsonArray &cookies) {
    // Never log the values.
    qInfo("sending %lld pathofexile.com cookies", qlonglong(cookies.size()));
    m_link.send({{"type", "cookies"}, {"cookies", cookies}});
  });

  m_engine = new QQmlEngine(this);
  m_engine->rootContext()->setContextProperty(QStringLiteral("host"), this);
  m_engine->rootContext()->setContextProperty(QStringLiteral("webProfile"), m_profile);

  // Preloaded and kept alive, so the first price check only maps the surface.
  m_overlayWindow = createWindow(QStringLiteral("Overlay.qml"));
  if (!m_overlayWindow) return false;
  m_overlay = new Overlay(m_overlayWindow, this);
  connect(m_overlay, &Overlay::stateChanged, this, &Host::sendOverlayState);
  connect(m_overlay, &Overlay::warning, this,
          [this](const QString &message) { log(QStringLiteral("warn"), message); });

  connect(&m_link, &BackendLink::connected, this, &Host::onConnected);
  connect(&m_link, &BackendLink::message, this, &Host::onMessage);
  // Queued: a first attempt that fails outright reports it from inside
  // connectToBackend() below, before main() enters the event loop, where
  // exit() would do nothing.
  connect(
      &m_link, &BackendLink::closed, this,
      [](bool connected) { QCoreApplication::exit(connected ? 0 : 1); }, Qt::QueuedConnection);
  m_link.connectToBackend();
  return true;
}

void Host::onConnected() {
  m_link.send({
      {"type", "hello"},
      {"version", QStringLiteral(OMAEXILED_HOST_VERSION)},
      {"userAgent", m_profile->httpUserAgent()},
  });
  sendOverlayState();
  if (m_pageLoaded) m_cookies->start();
}

// overlay.show / overlay.prepare: the game window, monitor-local logical px.
static QRect gameRect(const QJsonObject &message) {
  const QJsonObject r = message.value("rect").toObject();
  return QRectF(r.value("x").toDouble(), r.value("y").toDouble(), r.value("width").toDouble(),
                r.value("height").toDouble())
      .toRect();
}

void Host::onMessage(const QJsonObject &message) {
  const QString type = message.value("type").toString();

  if (type == u"overlay.show") {
    m_overlay->show(message.value("output").toString(), gameRect(message));
  } else if (type == u"overlay.prepare") {
    // Lay the hidden page out at the game window now, so the next item-text
    // reads the right size. Before the page has loaded, its warm-up
    // (pageLoaded) uses this geometry.
    if (m_overlay->prepare(message.value("output").toString(), gameRect(message)) &&
        m_overlayLoaded)
      m_overlay->warmUp();
  } else if (type == u"overlay.hide") {
    m_overlay->hide();
  } else if (type == u"overlay.input") {
    QList<QRectF> rects;
    for (const QJsonValue &v : message.value("rects").toArray()) {
      const QJsonObject r = v.toObject();
      rects.append(QRectF(r.value("x").toDouble(), r.value("y").toDouble(),
                          r.value("width").toDouble(), r.value("height").toDouble()));
    }
    m_overlay->setInput(rects, message.value("full").toBool());
  } else if (type == u"settings.open") {
    openSettings();
  } else if (type == u"settings.close") {
    closeSettings();
  } else if (type == u"browser.open") {
    openBrowser(QUrl(message.value("url").toString()));
  } else if (type == u"devtools") {
    openDevTools(message.value("target").toString());
  } else if (type == u"quit") {
    qInfo("quit requested by the backend");
    QCoreApplication::exit(0);
  } else {
    log(QStringLiteral("warn"), QStringLiteral("unknown message type \"%1\"").arg(type));
  }
}

void Host::sendOverlayState() {
  m_link.send({
      {"type", "overlay.state"},
      {"mapped", m_overlay->isMapped()},
      {"keyboardFocus", m_overlay->hasKeyboardFocus()},
  });
}

QQuickWindow *Host::createWindow(const QString &file, const QVariantMap &properties) {
  QQmlComponent component(m_engine, QUrl(QStringLiteral("qrc:/qml/") + file));
  QObject *object = component.createWithInitialProperties(properties);
  if (!object) {
    for (const QQmlError &error : component.errors())
      qCritical("%s", qPrintable(error.toString()));
    log(QStringLiteral("error"), QStringLiteral("cannot create %1").arg(file));
    return nullptr;
  }
  auto *window = qobject_cast<QQuickWindow *>(object);
  if (!window) {
    delete object;
    log(QStringLiteral("error"), QStringLiteral("%1 is not a window").arg(file));
  }
  return window;
}

void Host::raise(QQuickWindow *window) {
  window->show();
  window->raise();
  window->requestActivate();
}

void Host::openSettings() {
  // Created on open; a user close drops it (windowClosed), a backend
  // settings.close only hides it.
  if (!m_settings) m_settings = createWindow(QStringLiteral("Settings.qml"));
  if (m_settings) raise(m_settings);
}

void Host::closeSettings() {
  if (m_settings) m_settings->hide();
}

void Host::openBrowser(const QUrl &url) {
  if (!m_browser) m_browser = createWindow(QStringLiteral("Browser.qml"));
  if (!m_browser) return;
  if (url.isValid() && !url.isEmpty()) {
    if (QObject *view = m_browser->property("view").value<QObject *>())
      view->setProperty("url", url);
  }
  raise(m_browser);
}

void Host::openDevTools(const QString &target) {
  if (QQuickWindow *window = m_devtools.value(target)) {
    raise(window);
    return;
  }
  QQuickWindow *page = nullptr;
  if (target == u"overlay") {
    page = m_overlayWindow;
  } else if (target == u"settings") {
    if (!m_settings) openSettings();
    page = m_settings;
  } else if (target == u"browser") {
    page = m_browser;
  }
  QObject *view = page ? page->property("view").value<QObject *>() : nullptr;
  if (!view) {
    log(QStringLiteral("warn"), QStringLiteral("devtools: no page \"%1\"").arg(target));
    return;
  }
  QQuickWindow *window = createWindow(
      QStringLiteral("DevTools.qml"),
      {{"inspected", QVariant::fromValue(view)}, {"target", target}});
  if (!window) return;
  m_devtools.insert(target, window);
  raise(window);
}

void Host::devToolsClosed(const QString &target) {
  if (QQuickWindow *window = m_devtools.take(target)) window->deleteLater();
}

QUrl Host::pageUrl(const QString &mode) const {
  QUrl url(m_base);
  if (url.path().isEmpty()) url.setPath(QStringLiteral("/"));
  QUrlQuery query;
  query.addQueryItem(QStringLiteral("mode"), mode);
  url.setQuery(query);
  return url;
}

bool Host::isAppUrl(const QUrl &url) const {
  if (url.scheme() != u"http" && url.scheme() != u"https") return true; // about:, data:, blob:
  const auto port = [](const QUrl &u) { return u.port(u.scheme() == u"https" ? 443 : 80); };
  const QString host = url.host();
  return url.scheme() == m_base.scheme() && port(url) == port(m_base) &&
         (host == m_base.host() || host == u"127.0.0.1" || host == u"localhost");
}

QUrl Host::fromUserInput(const QString &text) const {
  return QUrl::fromUserInput(text.trimmed());
}

void Host::openExternal(const QUrl &url) {
  // Only web links: a page must not be able to launch local files.
  if (url.scheme() != u"http" && url.scheme() != u"https") {
    log(QStringLiteral("warn"), QStringLiteral("not opening %1 link").arg(url.scheme()));
    return;
  }
  qInfo("opening %s://%s in the browser", qPrintable(url.scheme()), qPrintable(url.host()));
  QDesktopServices::openUrl(url);
}

void Host::consoleMessage(const QString &page, int level, const QString &message, int line,
                          const QString &source) {
  static const char *const levels[] = {"log", "warn", "error"};
  const char *name = levels[qBound(0, level, 2)];
  // Every line carries the page name, so the backend log can be grepped.
  qInfo("[%s] console.%s: %s (%s:%d)", qPrintable(page), name, qPrintable(message),
        qPrintable(source), line);
}

void Host::log(const QString &level, const QString &message) {
  if (level == u"error")
    qCritical("%s", qPrintable(message));
  else if (level == u"warn")
    qWarning("%s", qPrintable(message));
  else
    qInfo("%s", qPrintable(message));
  m_link.send({{"type", "log"}, {"level", level}, {"message", message}});
}

void Host::pageLoaded(const QString &page, qint64 rendererPid) {
  log(QStringLiteral("info"),
      QStringLiteral("%1 page loaded (renderer pid %2)").arg(page).arg(rendererPid));
  if (page == u"overlay") {
    m_overlayLoaded = true;
    if (!m_overlay->isMapped()) m_overlay->warmUp();
  }
  m_pageLoaded = true;
  if (m_link.isConnected()) m_cookies->start();
}

void Host::windowClosed(const QString &name) {
  if (name == u"settings" && m_settings) {
    // QtWebEngine honours a page's window.close() (the settings page's
    // Save, Cancel and X) only once per view, even across reloads, and a
    // view created in a window that was already shown stays blank. So a
    // closed settings window is dropped and the next open creates a new
    // one, like the first open; unsaved edits are dropped with it.
    if (QQuickWindow *devtools = m_devtools.value(name)) devtools->close();
    m_settings->deleteLater();
    m_settings = nullptr;
  }
  m_link.send({{"type", "window.closed"}, {"window", name}});
}
