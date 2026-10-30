#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QLocalSocket>
#include <QObject>
#include <QTimer>

// NDJSON connection to the backend's host.sock: one JSON object per line,
// both directions. The backend listens, the host connects.
class BackendLink : public QObject {
  Q_OBJECT

public:
  explicit BackendLink(const QString &socketPath, QObject *parent = nullptr);
  ~BackendLink() override;

  void connectToBackend();
  bool isConnected() const;
  void send(const QJsonObject &message);

signals:
  void connected();
  void message(const QJsonObject &message);
  // The backend went away (connected) or never answered (!connected): the
  // host exits and the backend starts a new one when it needs it.
  void closed(bool connected);

private:
  void onReadyRead();
  void onError(QLocalSocket::LocalSocketError error);

  QString m_path;
  QLocalSocket m_socket;
  QByteArray m_buffer;
  QTimer m_retry;
  int m_attempts = 0;
  bool m_wasConnected = false;
};
