# OmaExiled Qt host: shows the renderer in an overlay layer surface, the
# settings window and the in-app browser. Driven by the backend over
# host.sock (see DESIGN.md "Backend <-> host").
#
#   cd host && mkdir -p build && qmake6 -o build/Makefile omaexiled-host.pro && make -C build

TEMPLATE = app
TARGET   = omaexiled-host
VERSION  = 0.1.0
CONFIG  += c++20 release warn_on
CONFIG  -= app_bundle
QT      += core gui network sql quick qml webenginequick webenginecore

# LayerShellQt ships only a CMake package (no .pc, no .pri). Its headers are in
# /usr/include/LayerShellQt/, on the default include path.
LIBS    += -lLayerShellQtInterface

DEFINES += OMAEXILED_HOST_VERSION=\\\"$$VERSION\\\"

# Relative to the Makefile's directory (build/), which also gets the binary.
OBJECTS_DIR = obj
MOC_DIR     = moc
RCC_DIR     = rcc

SOURCES += \
    src/main.cpp \
    src/backendlink.cpp \
    src/cookiewatcher.cpp \
    src/host.cpp \
    src/overlay.cpp

HEADERS += \
    src/backendlink.h \
    src/cookiewatcher.h \
    src/host.h \
    src/overlay.h

RESOURCES += qml/qml.qrc
