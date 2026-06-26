import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import QtQuick.Effects

Item {
    id: homeRoot
    anchors.fill: parent

    // Deep Cosmic Background
    Rectangle {
        anchors.fill: parent
        color: "#030305"
        
        Image {
            id: bgImage
            anchors.fill: parent
            source: "assets/home_bg.png"
            fillMode: Image.PreserveAspectCrop
            opacity: 0.6
        }

        MultiEffect {
            source: bgImage
            anchors.fill: bgImage
            blurEnabled: true
            blur: 0.3
            brightness: -0.1
        }
    }

    // Centered Content
    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width * 0.9, 800)
        spacing: 40

        // Brand Section
        ColumnLayout {
            Layout.alignment: Qt.AlignHCenter
            spacing: 4

            Text {
                text: "bucks"
                font.family: "Outfit"
                font.pixelSize: 64
                font.weight: Font.DemiBold
                color: "white"
                Layout.alignment: Qt.AlignHCenter
                opacity: 0.9
            }

            Text {
                text: "soul of the world"
                color: Qt.rgba(1, 1, 1, 0.4)
                font.family: "Inter"
                font.pixelSize: 12
                font.letterSpacing: 2
                Layout.alignment: Qt.AlignHCenter
            }
        }

        // Minimalist AI Search Bar
        Rectangle {
            id: searchBar
            Layout.fillWidth: true
            Layout.preferredHeight: 60
            radius: 30
            color: Qt.rgba(255, 255, 255, 0.05)
            border.color: Qt.rgba(255, 255, 255, 0.1)
            border.width: 1

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 20
                anchors.rightMargin: 10
                spacing: 15

                // Model Selector (Stub)
                Row {
                    spacing: 8; Layout.alignment: Qt.AlignVCenter
                    Text {
                        text: "Gemini 3.1 Pro (High)"
                        color: Qt.rgba(1, 1, 1, 0.6)
                        font.family: "Inter"
                        font.pixelSize: 13
                    }
                    Text {
                        text: "" // Material expand icon
                        font.family: "MaterialIcons-Regular"
                        color: Qt.rgba(1, 1, 1, 0.4)
                        font.pixelSize: 14
                        verticalAlignment: Text.AlignVCenter
                    }
                }

                Rectangle { width: 1; height: 24; color: Qt.rgba(1, 1, 1, 0.1) }

                TextField {
                    id: searchInput
                    Layout.fillWidth: true
                    font.family: "Inter"
                    font.pixelSize: 16
                    color: "white"
                    placeholderText: "Ask Bucks anything..."
                    placeholderTextColor: Qt.rgba(1, 1, 1, 0.3)
                    background: null
                    verticalAlignment: Text.AlignVCenter
                    onAccepted: window.navigateToUrl(text)
                }

                // Submit Button (Up Arrow)
                RoundButton {
                    Layout.preferredWidth: 40
                    Layout.preferredHeight: 40
                    background: Rectangle {
                        radius: 20
                        color: parent.pressed ? Qt.rgba(1, 1, 1, 0.2) : Qt.rgba(1, 1, 1, 0.1)
                    }
                    contentItem: Text {
                        text: "" // Material upward arrow icon
                        font.family: "MaterialIcons-Regular"
                        font.pixelSize: 20
                        color: "white"
                        horizontalAlignment: Text.AlignHCenter
                        verticalAlignment: Text.AlignVCenter
                    }
                    onClicked: window.navigateToUrl(searchInput.text)
                }
            }
        }
    }
}
