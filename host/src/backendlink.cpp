#include "backendlink.h"

#include <QJsonDocument>
#include <QJsonParseError>

// The backend listens before it starts the host, so the socket is normally
// there right away. Retry briefly anyway (startup races, slow disks).
static constexpr int kRetryInterval = 100;
static constexpr int kMaxAttempts = 50;

BackendLink::BackendLink(const QString &socketPath, QObject *parent)
    : QObject(parent), m_path(socketPath) {
  m_retry.setSingleShot(true);
  m_retry.setInterval(kRetryInterval);
  connect(&m_retry, &QTimer::timeout, this, &BackendLink::connectToBackend);

  connect(&m_socket, &QLocalSocket::connected, this, [this] {
    m_wasConnected = true;
    emit connected();
  });
  connect(&m_socket, &QLocalSocket::readyRead, this, &BackendLink::onReadyRead);
  connect(&m_socket, &QLocalSocket::errorOccurred, this, &BackendLink::onError);
  connect(&m_socket, &QLocalSocket::disconnected, this, [this] {
    if (m_wasConnected) {
      qInfo("backend closed the socket");
      emit closed(true);
    }
  });
}

BackendLink::~BackendLink() {
  // Destroying the socket emits disconnected(): not the backend's doing.
  m_socket.disconnect(this);
}

void BackendLink::connectToBackend() {
  ++m_attempts;
  m_socket.connectToServer(m_path);
}

bool BackendLink::isConnected() const {
  return m_socket.state() == QLocalSocket::ConnectedState;
}

void BackendLink::send(const QJsonObject &message) {
  if (!isConnected()) return;
  QByteArray line = QJsonDocument(message).toJson(QJsonDocument::Compact);
  line.append('\n');
  m_socket.write(line);
}

void BackendLink::onReadyRead() {
  m_buffer.append(m_socket.readAll());
  qsizetype end;
  while ((end = m_buffer.indexOf('\n')) >= 0) {
    const QByteArray line = m_buffer.left(end).trimmed();
    m_buffer.remove(0, end + 1);
    if (line.isEmpty()) continue;

    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(line, &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject()) {
      qWarning("invalid message from backend: %s", qPrintable(err.errorString()));
      continue;
    }
    emit message(doc.object());
  }
}

void BackendLink::onError(QLocalSocket::LocalSocketError error) {
  if (m_wasConnected) {
    // A connected socket reports PeerClosedError before disconnected();
    // disconnected() handles the exit.
    return;
  }
  if ((error == QLocalSocket::ServerNotFoundError ||
       error == QLocalSocket::ConnectionRefusedError) &&
      m_attempts < kMaxAttempts) {
    m_retry.start();
    return;
  }
  qWarning("cannot connect to %s: %s", qPrintable(m_path),
           qPrintable(m_socket.errorString()));
  emit closed(false);
}
