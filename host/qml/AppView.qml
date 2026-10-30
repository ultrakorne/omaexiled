// A renderer page (overlay or settings): the app origin only, links go to
// the user's browser, console output goes to the host log, and the page
// comes back by itself after a renderer crash or a failed load.
import QtQuick
import QtWebEngine

WebEngineView {
    id: view

    // "overlay" / "settings": the renderer mode and the log prefix.
    required property string page
    property bool loadFailureLogged: false

    profile: webProfile
    url: host.pageUrl(page)
    focus: true

    settings.focusOnNavigationEnabled: false
    settings.javascriptCanAccessClipboard: true
    settings.javascriptCanPaste: true
    settings.spatialNavigationEnabled: false

    // No Qt context menu; the DOM contextmenu event still fires.
    onContextMenuRequested: request => request.accepted = true

    // window.open / target=_blank (trade site, wiki, poedb, ...).
    onNewWindowRequested: request => host.openExternal(request.requestedUrl)

    onNavigationRequested: request => {
        if (request.isMainFrame && !host.isAppUrl(request.url)) {
            request.reject();
            host.openExternal(request.url);
        }
    }

    onJavaScriptConsoleMessage: (level, message, lineNumber, sourceID) =>
        host.consoleMessage(page, level, message, lineNumber, sourceID)

    onRenderProcessTerminated: (terminationStatus, exitCode) => {
        host.log("warn", page + " page renderer process ended (status " + terminationStatus
                 + ", exit code " + exitCode + "), reloading");
        recover.restart();
    }

    onLoadingChanged: info => {
        if (info.status === WebEngineLoadingInfo.LoadSucceededStatus) {
            loadFailureLogged = false;
            host.pageLoaded(page, renderProcessPid);
        } else if (info.status === WebEngineLoadingInfo.LoadFailedStatus && host.isAppUrl(info.url)
                   && (info.errorDomain === WebEngineLoadingInfo.ConnectionErrorDomain
                       || (info.errorDomain === WebEngineLoadingInfo.HttpStatusCodeDomain
                           && info.errorCode >= 500))) {
            // The backend is (re)starting: keep trying.
            if (!loadFailureLogged)
                host.log("warn", page + " page failed to load: " + info.errorString + ", retrying");
            loadFailureLogged = true;
            recover.restart();
        }
    }

    Timer {
        id: recover
        interval: 1000
        onTriggered: view.url = host.pageUrl(view.page)
    }
}
