#pragma once

#include <QJsonArray>
#include <QMap>
#include <QNetworkCookie>
#include <QObject>
#include <QTimer>

class QWebEngineCookieStore;

// Mirrors the profile's cookies for pathofexile.com and its subdomains, so
// the backend's trade proxy can send the same POESESSID / cf_clearance as
// the in-app browser. Emits the full current set after every change.
class CookieWatcher : public QObject {
  Q_OBJECT

public:
  explicit CookieWatcher(QWebEngineCookieStore *store, QObject *parent = nullptr);

  // Emits cookiesChanged for the cookies already in the store, and for
  // later changes. Call once the backend link is up and a page has loaded:
  // QWebEngineCookieStore::loadAllCookies() called before the profile's
  // network context exists never answers, and blocks later calls (Qt 6.11).
  void start();
  // Loads the pathofexile.com cookies the last session persisted, straight
  // from the profile's cookie database, because loadAllCookies() does not
  // replay them. Call before any page uses the profile (Chromium then opens
  // the database). Returns how many it found.
  int seedFromDatabase(const QString &storagePath);
  QJsonArray cookies() const;

  static bool isWatchedDomain(const QString &domain);

signals:
  void cookiesChanged(const QJsonArray &cookies);

private:
  void onAdded(const QNetworkCookie &cookie);
  void onRemoved(const QNetworkCookie &cookie);
  void flush();

  QWebEngineCookieStore *m_store;
  QMap<QString, QNetworkCookie> m_cookies;
  QTimer m_debounce;
  QJsonArray m_lastSent;
  bool m_started = false;
};
