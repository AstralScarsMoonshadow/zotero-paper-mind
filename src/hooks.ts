import {
  registerPaperAssistantMenu,
  unregisterPaperAssistantMenu,
} from "./modules/menu";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  registerPaperAssistantMenu(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterPaperAssistantMenu(win);
}

function onShutdown(): void {
  addon.data.alive = false;

  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: any },
) {
  return;
}

async function onPrefsEvent(_type: string, _data: { [key: string]: any }) {
  return;
}

function onShortcuts(_type: string) {
  return;
}

function onDialogEvents(_type: string) {
  return;
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
