#include "overlay.h"

#include <LayerShellQt/Window>
#include <QGuiApplication>
#include <QQuickWindow>
#include <QScreen>

using LayerWindow = LayerShellQt::Window;

Overlay::Overlay(QQuickWindow *window, QObject *parent)
    : QObject(parent), m_window(window) {
  // Must happen before the first show(): the layer surface is created with
  // the scope, layer and output set at that moment.
  m_layer = LayerWindow::get(m_window);
  m_layer->setScope(QStringLiteral("omaexiled"));
  m_layer->setLayer(LayerWindow::LayerOverlay);
  m_layer->setAnchors(LayerWindow::Anchors(LayerWindow::AnchorTop | LayerWindow::AnchorBottom |
                                           LayerWindow::AnchorLeft | LayerWindow::AnchorRight));
  // -1: margins count from the monitor edge, ignoring the bar's zone.
  m_layer->setExclusiveZone(-1);
  m_layer->setKeyboardInteractivity(LayerWindow::KeyboardInteractivityNone);
  m_layer->setActivateOnShow(false);
  // A dismissed surface (output gone) is handled here, the window stays.
  m_layer->setCloseOnDismissed(false);

  connect(m_window, &QWindow::activeChanged, this,
          [this] { setState(m_mapped, m_mapped && m_window->isActive()); });
  connect(qApp, &QGuiApplication::screenRemoved, this, &Overlay::onScreenRemoved);

  // Click-through until the page reports what it shows.
  applyInput();
}

// Layer surface margins that make a full-screen anchored surface cover rect
// (monitor-local); an invalid rect means the whole monitor.
static QMargins marginsFor(const QScreen *screen, const QRect &rect) {
  const QSize size = screen->geometry().size();
  const QRect r = rect.isValid() ? rect : QRect(QPoint(0, 0), size);
  return QMargins(qMax(0, r.left()), qMax(0, r.top()),
                  qMax(0, size.width() - r.left() - r.width()),
                  qMax(0, size.height() - r.top() - r.height()));
}

QScreen *Overlay::screenNamed(const QString &output, const QString &command) {
  for (QScreen *s : QGuiApplication::screens()) {
    if (s->name() == output) return s;
  }
  emit warning(QStringLiteral("%1: no output named \"%2\"").arg(command, output));
  return nullptr;
}

bool Overlay::show(const QString &output, const QRect &rect) {
  QScreen *screen = screenNamed(output, QStringLiteral("overlay.show"));
  if (!screen) return false;
  const QMargins margins = marginsFor(screen, rect);
  m_targetScreen = screen;
  m_targetMargins = margins;

  // A real show takes over a warm-up surface (still mapped with keyboard
  // none; the first-frame step below runs as usual).
  m_warmingUp = false;

  // A layer surface lives on one output: moving means a new surface.
  if (m_window->isVisible() && screen != m_screen) unmap();

  if (m_window->isVisible()) {
    if (margins != m_margins) {
      m_margins = margins;
      m_layer->setMargins(margins);
      m_window->update(); // layer state applies on the next commit
    }
    return true;
  }

  map(screen, margins);
  return true;
}

bool Overlay::prepare(const QString &output, const QRect &rect) {
  QScreen *screen = screenNamed(output, QStringLiteral("overlay.prepare"));
  if (!screen) return false;
  m_targetScreen = screen;
  m_targetMargins = marginsFor(screen, rect);
  return screen != m_screen || m_targetMargins != m_margins;
}

void Overlay::warmUp() {
  QScreen *screen = m_targetScreen ? m_targetScreen.data() : QGuiApplication::primaryScreen();
  if (!screen) return;
  const QMargins margins = m_targetScreen ? m_targetMargins : QMargins();
  if (m_window->isVisible()) {
    // A shown overlay keeps its surface; a warm-up already there is enough.
    if (!m_warmingUp || (screen == m_screen && margins == m_margins)) return;
    unmap(); // start over at the new geometry
  }
  m_warmingUp = true;
  map(screen, margins);
}

void Overlay::map(QScreen *screen, const QMargins &margins) {
  m_screen = screen;
  m_margins = margins;
  m_window->setScreen(screen);
  m_layer->setScreen(screen);
  m_layer->setMargins(margins);
  // Mapping with on_demand would take the keyboard from the game.
  m_layer->setKeyboardInteractivity(LayerWindow::KeyboardInteractivityNone);
  m_window->resize(screen->geometry().size().shrunkBy(margins));
  // See onFrameSwapped.
  m_framesToMap = 2;
  m_frameSwapped = connect(m_window, &QQuickWindow::frameSwapped, this, &Overlay::onFrameSwapped,
                         Qt::QueuedConnection); // emitted on the render thread
  m_window->show();
  applyInput();
  m_window->update();
}

void Overlay::hide() {
  m_warmingUp = false;
  // The page reports a fresh input region for the next show.
  m_inputRegion = QRegion();
  m_inputFull = false;
  if (m_window->isVisible()) unmap();
  applyInput();
}

void Overlay::unmap() {
  m_framesToMap = 0;
  disconnect(m_frameSwapped);
  m_layer->setKeyboardInteractivity(LayerWindow::KeyboardInteractivityNone);
  // Destroys the layer surface; the game gets direct scanout back.
  m_window->hide();
  setState(false, false);
}

void Overlay::setInput(const QList<QRectF> &rects, bool full) {
  QRegion region;
  for (const QRectF &r : rects) {
    if (!r.isEmpty()) region += r.toAlignedRect();
  }
  if (full == m_inputFull && region == m_inputRegion) return;
  m_inputRegion = region;
  m_inputFull = full;
  applyInput();
}

void Overlay::applyInput() {
  // QWindow::setMask(empty) means "whole surface", so an empty input region
  // needs WindowTransparentForInput instead.
  const bool none = !m_inputFull && m_inputRegion.isEmpty();
  m_window->setMask(m_inputFull ? QRegion() : m_inputRegion);
  m_window->setFlag(Qt::WindowTransparentForInput, none);
  if (m_window->isVisible()) m_window->update(); // input region applies on commit
}

void Overlay::onFrameSwapped() {
  // Hyprland maps the surface after the commit of the first frame, not at
  // it: switching to on_demand right after the first swap still counts as
  // "on_demand at map" and takes the keyboard from the game (measured). Qt
  // swaps the second frame only after the compositor's frame callback for
  // the first, i.e. after it has shown the surface.
  if (m_framesToMap == 0 || !m_window->isVisible()) return;
  if (--m_framesToMap > 0) {
    m_window->update();
    return;
  }
  disconnect(m_frameSwapped);
  if (m_warmingUp) {
    // Exposed once: Chromium has the viewport size now.
    m_warmingUp = false;
    unmap();
    return;
  }
  // The surface is mapped now (with interactivity none, so the game kept
  // the keyboard). From here on hovering the panel may focus it.
  m_layer->setKeyboardInteractivity(LayerWindow::KeyboardInteractivityOnDemand);
  m_window->update();
  setState(true, m_window->isActive());
}

void Overlay::setState(bool mapped, bool keyboardFocus) {
  if (mapped == m_mapped && keyboardFocus == m_keyboardFocus) return;
  m_mapped = mapped;
  m_keyboardFocus = keyboardFocus;
  emit stateChanged();
}

void Overlay::onScreenRemoved(QScreen *screen) {
  if (screen != m_screen || !m_window->isVisible()) return;
  m_warmingUp = false;
  unmap();
  emit warning(QStringLiteral("overlay output %1 was removed").arg(screen->name()));
}
