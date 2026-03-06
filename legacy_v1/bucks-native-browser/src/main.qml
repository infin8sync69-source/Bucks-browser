import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtWebEngine
import QtQuick.Window

Window {
    id: window
    visible: true
    width: 1280
    height: 800
    title: "Bucks Browser"
    color: "#030305"

    property bool isWalletView: false
    property bool isHomeView: true

    function navigateToUrl(target) {
        if (target.startsWith("bucks://home")) {
            isHomeView = true;
            isWalletView = false;
        } else if (target.startsWith("bucks://wallet")) {
            isHomeView = false;
            isWalletView = true;
        } else {
            isHomeView = false;
            isWalletView = false;
            if (!target.includes("://")) target = "https://search.brave.com/search?q=" + encodeURIComponent(target);
            webView.url = target;
        }
    }

    // Header Section (Slim & Minimalist)
    Rectangle {
        id: header
        width: parent.width; height: 50; z: 10
        color: Qt.rgba(0, 0, 0, 0.4)

        RowLayout {
            anchors.fill: parent; anchors.leftMargin: 12; anchors.rightMargin: 12; spacing: 10
            
            // Traffic Lights
            Row {
                spacing: 8; Layout.alignment: Qt.AlignVCenter
                Rectangle { width: 12; height: 12; radius: 6; color: "#FF5F56" }
                Rectangle { width: 12; height: 12; radius: 6; color: "#FFBD2E" }
                Rectangle { width: 12; height: 12; radius: 6; color: "#27C93F" }
            }

            Item { Layout.fillWidth: true } // Spacer

            // URL Bar
            Rectangle {
                Layout.preferredWidth: 400; height: 32; color: Qt.rgba(1, 1, 1, 0.05); radius: 10; border.color: Qt.rgba(1, 1, 1, 0.1)
                TextField {
                    anchors.fill: parent; anchors.leftMargin: 10; verticalAlignment: Text.AlignVCenter
                    color: "white"; font.pixelSize: 12; background: null
                    text: isWalletView ? "bucks://wallet" : (isHomeView ? "" : webView.url)
                    placeholderText: "Search or enter address..."
                }
            }

            Item { Layout.fillWidth: true } // Spacer
        }
    }

    // Main Content
    Item {
        anchors.top: header.bottom; anchors.bottom: parent.bottom; anchors.left: parent.left; anchors.right: parent.right

        Home {
            anchors.fill: parent
            visible: isHomeView
        }

        WebEngineView {
            id: webView
            anchors.fill: parent
            visible: !isWalletView && !isHomeView
        }
    }
}
