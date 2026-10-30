// Fake "Path of Exile 2" window for testing OmaExiled without the game.
//
// Runs as an XWayland (xcb) client like PoE2 under Proton, so Hyprland
// binds, sendshortcut and the X11 <-> Wayland clipboard bridge behave as
// they do with the real game.
//
//   Ctrl+C / Ctrl+Alt+C  copy the next item from items/ to the clipboard
//   Enter                open chat; Enter again "sends" the line
//   Ctrl+F               open the stash search box; Enter commits it
//   Ctrl+A, Ctrl+V,
//   Backspace, Delete    edit the open chat / search line
//   Esc                  close chat / search
//
// Every key event and every action is appended to $FAKE_POE_LOG (default
// /tmp/fake-poe.log) so tests can assert what the game received.

#include <QApplication>
#include <QClipboard>
#include <QDir>
#include <QFile>
#include <QKeyEvent>
#include <QPainter>
#include <QTextStream>
#include <QWidget>

class FakePoe : public QWidget {
public:
  explicit FakePoe(const QString &itemsDir, const QString &title) {
    setWindowTitle(title);
    setFocusPolicy(Qt::StrongFocus);
    setMouseTracking(true);
    QDir dir(itemsDir);
    for (const QString &name : dir.entryList({"*.txt"}, QDir::Files, QDir::Name)) {
      QFile f(dir.filePath(name));
      if (f.open(QIODevice::ReadOnly)) items.append({name, QString::fromUtf8(f.readAll())});
    }
    logPath = qEnvironmentVariable("FAKE_POE_LOG", "/tmp/fake-poe.log");
    log(QString("START items=%1").arg(items.size()));
  }

protected:
  void keyPressEvent(QKeyEvent *e) override {
    const auto mods = e->modifiers();
    const bool ctrl = mods & Qt::ControlModifier;
    const bool alt = mods & Qt::AltModifier;
    log(QString("KEY key=%1 ctrl=%2 alt=%3 shift=%4 text=%5")
            .arg(QKeySequence(e->key()).toString())
            .arg(ctrl).arg(alt).arg(bool(mods & Qt::ShiftModifier))
            .arg(e->text().toHtmlEscaped()));

    if (ctrl && e->key() == Qt::Key_C && mode == Mode::Game) {
      if (!items.isEmpty()) {
        const auto &item = items[next++ % items.size()];
        QApplication::clipboard()->setText(item.second);
        log(QString("COPY %1 advanced=%2").arg(item.first).arg(alt));
        status = "copied " + item.first;
      }
    } else if (ctrl && e->key() == Qt::Key_F && mode == Mode::Game) {
      mode = Mode::Search;
      line.clear();
    } else if (e->key() == Qt::Key_Return || e->key() == Qt::Key_Enter) {
      if (mode == Mode::Game) {
        mode = Mode::Chat;
        line.clear();
      } else {
        log(QString("%1 %2").arg(mode == Mode::Chat ? "CHAT" : "STASH_SEARCH", line));
        status = (mode == Mode::Chat ? "sent: " : "searched: ") + line;
        mode = Mode::Game;
      }
    } else if (e->key() == Qt::Key_Escape) {
      mode = Mode::Game;
    } else if (mode != Mode::Game) {
      if (ctrl && e->key() == Qt::Key_A) {
        selectAll = true;
      } else if (ctrl && e->key() == Qt::Key_V) {
        const QString text = QApplication::clipboard()->text();
        line = selectAll ? text : line + text;
        selectAll = false;
      } else if (e->key() == Qt::Key_Backspace || e->key() == Qt::Key_Delete) {
        if (selectAll) line.clear(); else line.chop(1);
        selectAll = false;
      } else if (!e->text().isEmpty() && !ctrl) {
        line = selectAll ? e->text() : line + e->text();
        selectAll = false;
      }
    }
    update();
  }

  void mouseMoveEvent(QMouseEvent *e) override {
    const QPoint p = e->position().toPoint();
    // One line per 50px cell keeps the log readable while proving that
    // pointer motion reached the game through the overlay.
    const QPoint cell(p.x() / 50, p.y() / 50);
    if (cell != lastCell) log(QString("MOUSE_MOVE x=%1 y=%2").arg(p.x()).arg(p.y()));
    lastCell = cell;
  }

  void mousePressEvent(QMouseEvent *e) override {
    const QPoint p = e->position().toPoint();
    log(QString("MOUSE_PRESS x=%1 y=%2 button=%3").arg(p.x()).arg(p.y()).arg(int(e->button())));
  }

  void paintEvent(QPaintEvent *) override {
    QPainter p(this);
    p.fillRect(rect(), QColor(18, 14, 10));
    p.setPen(QColor(200, 180, 140));
    QFont f = font();
    f.setPointSize(16);
    p.setFont(f);
    p.drawText(rect().adjusted(40, 40, -40, -40), Qt::AlignTop | Qt::AlignLeft,
               QString("FAKE PATH OF EXILE 2\n\nCtrl+(Alt+)C copy item · Enter chat · Ctrl+F stash search\n\n%1\n\n%2")
                   .arg(status)
                   .arg(mode == Mode::Chat ? "CHAT> " + line
                        : mode == Mode::Search ? "SEARCH> " + line : QString()));
  }

private:
  enum class Mode { Game, Chat, Search };

  void log(const QString &msg) {
    QFile f(logPath);
    if (f.open(QIODevice::Append | QIODevice::Text)) QTextStream(&f) << msg << "\n";
  }

  QList<QPair<QString, QString>> items;
  int next = 0;
  Mode mode = Mode::Game;
  QString line;
  bool selectAll = false;
  QString status = "ready";
  QString logPath;
  QPoint lastCell{-1, -1};
};

int main(int argc, char **argv) {
  qputenv("QT_QPA_PLATFORM", "xcb");
  QApplication app(argc, argv);
  // --class / --title let a test window run next to a real PoE2 without
  // OmaExiled taking it for the game.
  QString itemsDir = QString(SRCDIR) + "/items";
  QString wmClass = "steam_app_2694490", title = "Path of Exile 2";
  const QStringList args = app.arguments().mid(1);
  for (int i = 0; i < args.size(); i++) {
    if (args[i] == "--class" && i + 1 < args.size()) wmClass = args[++i];
    else if (args[i] == "--title" && i + 1 < args.size()) title = args[++i];
    else if (!args[i].startsWith("--")) itemsDir = args[i];
  }
  app.setApplicationName(wmClass);
  FakePoe w(itemsDir, title);
  if (app.arguments().contains("--fullscreen")) w.showFullScreen();
  else { w.resize(1280, 800); w.show(); }
  return app.exec();
}
