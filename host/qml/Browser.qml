// In-app browser for pathofexile.com (Cloudflare check, login). It shares
// the profile with the renderer pages, so its cookies reach the backend's
// trade proxy (src/cookiewatcher.cpp).
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtWebEngine

ApplicationWindow {
    id: root

    property alias view: view

    function dismiss() {
        root.hide();
        // Stop the page (live searches, timers) while nobody looks at it.
        view.url = "about:blank";
        host.windowClosed("browser");
    }

    title: "OmaExiled Browser"
    width: 1200
    height: 900
    minimumWidth: 480
    minimumHeight: 360
    visible: false

    onClosing: event => {
        event.accepted = false;
        root.dismiss();
    }

    header: ToolBar {
        RowLayout {
            anchors.fill: parent
            spacing: 2

            ToolButton {
                text: "←"
                enabled: view.canGoBack
                onClicked: view.goBack()
                ToolTip.text: "Back"
                ToolTip.visible: hovered
            }
            ToolButton {
                text: "→"
                enabled: view.canGoForward
                onClicked: view.goForward()
                ToolTip.text: "Forward"
                ToolTip.visible: hovered
            }
            ToolButton {
                text: view.loading ? "✕" : "↻"
                onClicked: view.loading ? view.stop() : view.reload()
                ToolTip.text: view.loading ? "Stop" : "Reload"
                ToolTip.visible: hovered
            }
            TextField {
                id: address
                Layout.fillWidth: true
                selectByMouse: true
                onAccepted: {
                    view.url = host.fromUserInput(text);
                    view.forceActiveFocus();
                }
            }
            ToolButton {
                text: "Close"
                onClicked: root.dismiss()
            }
        }
    }

    WebEngineView {
        id: view
        anchors.fill: parent
        profile: webProfile
        focus: true

        onUrlChanged: {
            if (!address.activeFocus)
                address.text = url.toString() === "about:blank" ? "" : url;
        }
        // Popups (target=_blank) stay in this window and this cookie jar.
        onNewWindowRequested: request => view.url = request.requestedUrl
        onWindowCloseRequested: root.dismiss()
        onRenderProcessTerminated: (terminationStatus, exitCode) => {
            host.log("warn", "browser page renderer process ended (status " + terminationStatus
                     + ", exit code " + exitCode + ")");
            view.reload();
        }
    }
}
