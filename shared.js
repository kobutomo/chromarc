// background / sidepanel / options で共有する設定まわり

const DEFAULT_SETTINGS = {
  archiveEnabled: true,
  archiveValue: 12, // Arc の既定値は 12 時間
  archiveUnit: 'hours',
  fontSize: 13,
  bookmarkFolderId: null, // null = ブックマークバー
};

const UNIT_MS = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

const ARCHIVE_LIMIT = 200;

// 「名前なし」のタブに設定するタイトル。空文字や空白だけだと Chrome が URL を表示してしまうため、
// 空白として描画される文字 (点字の空白パターン) を使う
const BLANK_TITLE = '\u2800';
const stripBlank = (text) => (text ?? '').replaceAll(BLANK_TITLE, '');

// 分割ビュー (Chrome 155 以降の Split View API)。未対応の Chrome では常に null になる
const splitIdOf = (tab) =>
  typeof tab?.splitViewId === 'number' && tab.splitViewId !== -1 ? tab.splitViewId : null;

// ブックマークから開いたタブの ID 一覧。分割ビューの相方のタブも同じブックマークの一部として扱う
function linkedTabIdSet(links, tabs) {
  const ids = new Set(Object.values(links));
  const splits = new Set(
    tabs
      .filter((tab) => ids.has(tab.id))
      .map(splitIdOf)
      .filter((id) => id !== null),
  );
  for (const tab of tabs) {
    if (splits.has(splitIdOf(tab))) ids.add(tab.id);
  }
  return ids;
}

// ブックマークから開いたタブの favicon を覚えておく。
// (Chrome の favicon キャッシュは、リダイレクトされる URL などでは引けないことがある)
const usableFavicon = (url) => /^(https?:|data:)/.test(url ?? '') && url.length < 20000;

async function saveBookmarkFavicon(bookmarkId, favIconUrl) {
  if (!usableFavicon(favIconUrl)) return;
  const { favicons = {} } = await chrome.storage.local.get('favicons');
  if (favicons[bookmarkId] === favIconUrl) return;
  favicons[bookmarkId] = favIconUrl;
  await chrome.storage.local.set({ favicons });
}

// 会議中のタブ (Google Meet)。サイドバーでは「Current Meeting」にまとめ、自動アーカイブやクリアの対象外にする
function isMeetingTab(tab) {
  try {
    return new URL(tab.url ?? '').hostname === 'meet.google.com';
  } catch {
    return false;
  }
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}
