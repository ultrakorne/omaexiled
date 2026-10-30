#pragma once

#include <QList>
#include <QMargins>
#include <QObject>
#include <QPointer>
#include <QRect>
#include <QRegion>

class QQuickWindow;
class QScreen;
namespace LayerShellQt {
class Window;
}

// The overlay layer surface (DESIGN.md "Overlay model"): layer overlay,
// namespace "omaexiled", anchored to all edges with margins so it covers the
// game window, exclusive zone -1. Mapped with keyboard interactivity none,
// switched to on_demand once the compositor has shown it, so the game keeps
// the keyboard until the pointer moves over the panel. The window (and its
// page) lives for the whole host lifetime; hide() only destroys the layer
// surface.
class Overlay : public QObject {
  Q_OBJECT

public:
  explicit Overlay(QQuickWindow *window, QObject *parent = nullptr);

  QQuickWindow *window() const { return m_window; }
  bool isMapped() const { return m_mapped; }
  bool hasKeyboardFocus() const { return m_keyboardFocus; }

  // rect: game window in monitor-local logical px. Returns false (and does
  // nothing) if no screen has that name.
  bool show(const QString &output, const QRect &rect);
  void hide();
  // Chromium gives a page its viewport size only once the window has been
  // exposed, and the renderer reads innerWidth when item-text arrives, while
  // still hidden. So after the page loads, map once (click-through, keyboard
  // none, transparent page) and unmap after the first frame. Not reported as
  // mapped.
  void warmUp();
  // Input region in surface px: the union of rects, or the whole surface
  // when full. No rects and not full = no input at all (fully click-through).
  void setInput(const QList<QRectF> &rects, bool full);

signals:
  void stateChanged();
  void warning(const QString &message);

private:
  void map(QScreen *screen, const QMargins &margins);
  void unmap();
  void onFrameSwapped();
  void applyInput();
  void setState(bool mapped, bool keyboardFocus);
  void onScreenRemoved(QScreen *screen);

  QQuickWindow *m_window;
  LayerShellQt::Window *m_layer;
  QPointer<QScreen> m_screen;
  QMargins m_margins;
  QMetaObject::Connection m_frameSwapped;
  int m_framesToMap = 0;
  bool m_warmingUp = false;
  bool m_mapped = false;
  bool m_keyboardFocus = false;
  QRegion m_inputRegion;
  bool m_inputFull = false;
};
