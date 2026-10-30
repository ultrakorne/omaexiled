#pragma once

#include <QHash>
#include <QJsonObject>
#include <QObject>
#include <QPointer>
#include <QUrl>
#include <QVariantMap>

#include "backendlink.h"

class CookieWatcher;
class Overlay;
class QQmlEngine;
class QQuickWebEngineProfile;
class QQuickWindow;

// Glue between the backend (host.sock commands, see DESIGN.md
// "Backend <-> host") and the windows: the overlay layer surface, the
// settings window, the in-app browser and DevTools windows. Also the `host`
// object the QML pages call into.
class Host : public QObject {
  Q_OBJECT

public:
  Host(const QString &socketPath, const QUrl &baseUrl, QObject *parent = nullptr);
  ~Host() override;

  // Creates the profile and preloads the overlay page, then connects.
  bool start();

  // Page URL for a renderer mode: <base>/?mode=<mode>.
  Q_INVOKABLE QUrl pageUrl(const QString &mode) const;
  // Same origin as the renderer: may stay in the overlay / settings view.
  Q_INVOKABLE bool isAppUrl(const QUrl &url) const;
  Q_INVOKABLE QUrl fromUserInput(const QString &text) const;
  // window.open, target=_blank, foreign links: the user's browser.
  Q_INVOKABLE void openExternal(const QUrl &url);
  Q_INVOKABLE void consoleMessage(const QString &page, int level, const QString &message,
                                  int line, const QString &source);
  // Host diagnostics: stderr, and the backend log when connected.
  Q_INVOKABLE void log(const QString &level, const QString &message);
  Q_INVOKABLE void pageLoaded(const QString &page, qint64 rendererPid);
  // The user closed a window (window close button, page window.close()).
  Q_INVOKABLE void windowClosed(const QString &name);
  Q_INVOKABLE void devToolsClosed(const QString &target);

private:
  void onConnected();
  void onMessage(const QJsonObject &message);
  void sendOverlayState();
  QQuickWindow *createWindow(const QString &file, const QVariantMap &properties = {});
  void openSettings();
  void closeSettings();
  void openBrowser(const QUrl &url);
  void openDevTools(const QString &target);
  static void raise(QQuickWindow *window);

  BackendLink m_link;
  QUrl m_base;
  QQuickWebEngineProfile *m_profile = nullptr;
  CookieWatcher *m_cookies = nullptr;
  QQmlEngine *m_engine = nullptr;
  QQuickWindow *m_overlayWindow = nullptr;
  Overlay *m_overlay = nullptr;
  bool m_pageLoaded = false;
  QPointer<QQuickWindow> m_settings;
  QPointer<QQuickWindow> m_browser;
  QHash<QString, QPointer<QQuickWindow>> m_devtools;
};
