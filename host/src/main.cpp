// omaexiled-host --socket <path> --url <base>
//
// Started by the backend, which listens on <path> (host.sock). Talks NDJSON
// over that socket only: QtWebEngine's child processes inherit stdout and
// stderr, so stdio carries logs, never protocol data. Exits when the socket
// closes; the backend starts a new host when it needs one.

#include <QGuiApplication>
#include <QQuickWindow>
#include <QSocketNotifier>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>

#include <csignal>
#include <cstdio>
#include <sys/socket.h>
#include <unistd.h>

#include "host.h"

static int signalFds[2] = {-1, -1};

static void onSignal(int sig) {
  const char c = char(sig);
  (void)!::write(signalFds[0], &c, 1);
}

// SIGTERM / SIGINT / SIGHUP quit through the event loop, so Chromium can
// flush cookies and local storage to disk. (Every exit path uses exit(), not
// quit(): Qt 6's quit() first asks all windows to close and gives up if one
// refuses, and the settings and browser windows refuse, they only hide.)
static void installSignalHandlers(QObject *parent) {
  if (::socketpair(AF_UNIX, SOCK_STREAM, 0, signalFds) != 0) return;
  auto *notifier = new QSocketNotifier(signalFds[1], QSocketNotifier::Read, parent);
  QObject::connect(notifier, &QSocketNotifier::activated, parent, [] {
    char c = 0;
    (void)!::read(signalFds[1], &c, 1);
    qInfo("exiting on signal %d", int(c));
    QCoreApplication::exit(0);
  });
  struct sigaction sa = {};
  sa.sa_handler = onSignal;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_RESTART;
  for (int sig : {SIGTERM, SIGINT, SIGHUP}) sigaction(sig, &sa, nullptr);
}

static void usage() {
  std::fprintf(stderr, "usage: omaexiled-host --socket <path> --url <base url>\n");
}

int main(int argc, char **argv) {
  // Layer surfaces need the Wayland platform (the session says wayland;xcb),
  // and only this process decides which windows are layer surfaces.
  qputenv("QT_QPA_PLATFORM", "wayland");
  qunsetenv("QT_WAYLAND_SHELL_INTEGRATION");
  // Without this Qt logs to journald when stderr is not a terminal.
  qputenv("QT_FORCE_STDERR_LOGGING", "1");

  QString socketPath, baseUrl;
  for (int i = 1; i < argc; ++i) {
    const QByteArray arg = argv[i];
    if (arg == "--socket" && i + 1 < argc) socketPath = QString::fromLocal8Bit(argv[++i]);
    else if (arg == "--url" && i + 1 < argc) baseUrl = QString::fromLocal8Bit(argv[++i]);
    else if (arg == "--webEngineArgs") break; // the rest is Chromium's
  }
  const QUrl base(baseUrl);
  if (socketPath.isEmpty() || !base.isValid() || base.host().isEmpty()) {
    usage();
    return 2;
  }

  QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
  QtWebEngineQuick::initialize(); // before the application object
  QGuiApplication app(argc, argv);
  QGuiApplication::setApplicationName(QStringLiteral("omaexiled"));
  QGuiApplication::setApplicationVersion(QStringLiteral(OMAEXILED_HOST_VERSION));
  QGuiApplication::setDesktopFileName(QStringLiteral("omaexiled")); // xdg app_id
  // Windows are hidden, not closed, and DevTools windows come and go: only
  // the backend (or a signal) ends the host.
  QGuiApplication::setQuitOnLastWindowClosed(false);
  QQuickWindow::setDefaultAlphaBuffer(true); // translucent overlay

  installSignalHandlers(&app);

  Host host(socketPath, base);
  if (!host.start()) return 1;
  return app.exec();
}
