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
  explicit FakePoe(const QString &itemsDir) {
    setWindowTitle("Path of Exile 2");
    setFocusPolicy(Qt::StrongFocus);
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
};

int main(int argc, char **argv) {
  qputenv("QT_QPA_PLATFORM", "xcb");
  QApplication app(argc, argv);
  app.setApplicationName("steam_app_2694490");
  const QString itemsDir = argc > 1 ? argv[1] : QString(SRCDIR) + "/items";
  FakePoe w(itemsDir);
  if (app.arguments().contains("--fullscreen")) w.showFullScreen();
  else { w.resize(1280, 800); w.show(); }
  return app.exec();
}
