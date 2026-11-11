const $ = (selector) => document.querySelector(selector);

const els = {
  bookmarks: $('#bookmarks'),
  tabs: $('#tabs'),
  meeting: $('#meeting'),
  archiveList: $('#archive-list'),
  archiveCount: $('#archive-count'),
};

let windowId = null;
let rootFolderId = null;
let editing = false;
let pressing = false; // マウスボタンを押している間
let dragging = null; // ドラッグ中の行 { kind: 'tab' | 'bookmark', id, index }
let dirty = false;
let timer = null;
let renderSeq = 0;
let collapseTimer = null;

// 最後にフォルダを開いてからこの時間が経つと、すべてのフォルダを自動で閉じる
const FOLDER_AUTO_CLOSE_MS = 5 * 60 * 1000;

// フォルダアイコンに付けられる色 (右クリックメニューから選ぶ)
const FOLDER_COLORS = ['#6b8afd', '#4fb3d9', '#4cc38a', '#e5c04b', '#f0883e', '#ef6a6a', '#d77fd7', '#9d7df0'];

const FOLDER_ICON = {
  closed:
    '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2a1.5 1.5 0 0 1 1.06.44L8.3 3.5H13A1.5 1.5 0 0 1 14.5 5v7a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12z"/></svg>',
  open:
    '<svg viewBox="0 0 16 16" fill="currentColor"><path fill-opacity=".5" d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2a1.5 1.5 0 0 1 1.06.44L8.3 3.5H12A1.5 1.5 0 0 1 13.5 5v1H4.6a1.5 1.5 0 0 0-1.42 1.02L1.5 12z"/><path d="M4.6 7h9.9a.9.9 0 0 1 .85 1.2l-1.5 4.3a1.5 1.5 0 0 1-1.42 1H2.4a.9.9 0 0 1-.85-1.2l1.63-4.28A1.5 1.5 0 0 1 4.6 7z"/></svg>',
};

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') Object.assign(el.style, value);
    else el[key] = value;
  }
  el.append(...children.filter((child) => child != null));
  return el;
}

function faviconFor(url) {
  return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url ?? '')}&size=32`;
}

function favicon(url, favIconUrl) {
  const src = /^(https?:|data:)/.test(favIconUrl ?? '') ? favIconUrl : faviconFor(url);
  const img = h('img', { className: 'icon', src, draggable: false });
  img.addEventListener('error', () => {
    const fallback = faviconFor(url);
    if (img.src !== fallback) img.src = fallback;
  });
  return img;
}

function action(label, title, handler) {
  const button = h('button', { className: 'action', textContent: label, title });
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    handler();
  });
  button.addEventListener('dblclick', (event) => event.stopPropagation());
  return button;
}

// 音声を再生中 (またはミュート中) のタブに出すスピーカーボタン。クリックでミュートを切り替える
function audioButton(tab) {
  const muted = !!tab?.mutedInfo?.muted;
  if (!tab || (!tab.audible && !muted)) return null;
  const button = action(muted ? '🔇' : '🔊', muted ? 'ミュートを解除' : 'ミュート', () =>
    chrome.tabs.update(tab.id, { muted: !muted }),
  );
  button.classList.add('audio');
  return button;
}

function schedule() {
  // 名前の編集中・ドラッグ中に再描画すると操作対象の要素が消えてしまうので保留する
  if (editing || dragging || pressing) {
    dirty = true;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(render, 30);
}

// ------------------------------------------------------------------- 描画

function findFolder(nodes, id) {
  for (const node of nodes) {
    if (node.url) continue;
    if (node.id === id) return node;
    const found = findFolder(node.children ?? [], id);
    if (found) return found;
  }
  return null;
}

function resolveRootFolder(tree, id) {
  const top = tree[0]?.children ?? [];
  return (
    (id && findFolder(tree, id)) ||
    top.find((node) => node.folderType === 'bookmarks-bar') ||
    top[0] ||
    null
  );
}

async function render() {
  const seq = ++renderSeq;
  const [settings, local, session, allTabs, tree] = await Promise.all([
    getSettings(),
    chrome.storage.local.get([
      'renames',
      'archived',
      'openFolders',
      'foldersOpenedAt',
      'folderColors',
      'splitBookmarks',
      'favicons',
    ]),
    chrome.storage.session.get('links'),
    chrome.tabs.query({}),
    chrome.bookmarks.getTree(),
  ]);
  if (seq !== renderSeq || editing || dragging || pressing) return;

  document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);

  const renames = local.renames ?? {};
  let openFolders = local.openFolders ?? {};
  clearTimeout(collapseTimer);
  if (Object.keys(openFolders).length > 0) {
    const remaining = (local.foldersOpenedAt ?? 0) + FOLDER_AUTO_CLOSE_MS - Date.now();
    if (remaining <= 0) {
      // サイドバーを閉じている間に時間が過ぎていた場合
      openFolders = {};
      chrome.storage.local.set({ openFolders: {} });
    } else {
      collapseTimer = setTimeout(() => chrome.storage.local.set({ openFolders: {} }), remaining);
    }
  }
  const links = session.links ?? {};
  const tabById = new Map(allTabs.map((tab) => [tab.id, tab]));
  const splitBookmarks = local.splitBookmarks ?? {};
  const favicons = local.favicons ?? {};
  const folderColors = local.folderColors ?? {};
  const linkedTabIds = linkedTabIdSet(links, allTabs);
  // 分割ビューでは片方のタブだけが active になるので、相方が active でも「表示中」とみなす
  const isShown = (tab) =>
    !!tab &&
    tab.windowId === windowId &&
    (tab.active ||
      (splitIdOf(tab) !== null &&
        allTabs.some((t) => t.active && t.windowId === windowId && splitIdOf(t) === splitIdOf(tab))));

  // ブックマーク (Arc のピン留め領域に相当)
  const root = resolveRootFolder(tree, settings.bookmarkFolderId);
  rootFolderId = root?.id ?? null;

  const bookmarkRows = [];
  const tiles = []; // 名前なしのブックマークは Arc のお気に入りのようにアイコンだけのタイルで横に並べる
  // onlyOpen: 閉じたフォルダの中身を辿っているとき。開いているタブだけを表示する (Arc と同じ)
  const walk = (nodes, depth, onlyOpen = false) => {
    for (const node of nodes) {
      const indent = { paddingLeft: `${0.6 + depth * 1.1}em` };
      if (!node.url) {
        if (onlyOpen) {
          walk(node.children ?? [], depth, true);
          continue;
        }
        const open = !!openFolders[node.id];
        const row = h(
          'div',
          {
            className: 'row folder',
            dataset: { kind: 'bookmark', id: node.id, parent: node.parentId, index: String(node.index) },
            style: indent,
            draggable: true,
          },
          h('span', {
            className: 'icon',
            innerHTML: open ? FOLDER_ICON.open : FOLDER_ICON.closed,
            style: folderColors[node.id] ? { color: folderColors[node.id] } : {},
          }),
          h('span', { className: 'title', textContent: node.title || '(無題のフォルダ)' }),
        );
        row.addEventListener('click', () => toggleFolder(node.id));
        bookmarkRows.push(row);
        walk(node.children ?? [], depth + 1, !open);
        continue;
      }
      const tab = tabById.get(links[node.id]);
      if (onlyOpen && !tab) continue;
      const tile = depth === 0 && !node.title;
      const split = splitBookmarks[node.id]; // 分割ビューとして登録したブックマークの相方
      const row = h(
        'div',
        {
          className: `row bookmark${tile ? ' tile' : ''}${tab ? ' open' : ''}${isShown(tab) ? ' active' : ''}`,
          title: split ? `${node.url}\n${split.url}` : node.url,
          dataset: { kind: 'bookmark', id: node.id, parent: node.parentId, index: String(node.index) },
          style: tile ? {} : indent,
          draggable: true,
        },
        // 開いているタブの favicon、なければ以前開いたときに覚えた favicon を使う
        favicon(node.url, usableFavicon(tab?.favIconUrl) ? tab.favIconUrl : favicons[node.id]),
        split ? favicon(split.url, split.favIconUrl) : null,
        h('span', { className: 'title', textContent: node.title }),
        audioButton(tab),
        // タイルは小さいので、閉じる操作は右クリックメニューに置く
        tab && !tile
          ? action('×', 'タブを閉じる(ブックマークは残ります)', () => closeBookmarkTab(tab.id))
          : null,
      );
      row.addEventListener('click', () => openBookmark(node));
      (tile ? tiles : bookmarkRows).push(row);
    }
  };
  walk(root?.children ?? [], 0);
  if (bookmarkRows.length === 0 && tiles.length === 0) {
    bookmarkRows.push(h('div', { className: 'empty', textContent: 'ブックマークはありません' }));
  }
  els.bookmarks.replaceChildren(
    ...(tiles.length > 0 ? [h('div', { className: 'tiles' }, ...tiles)] : []),
    ...bookmarkRows,
  );

  const tabTitle = (tab) => {
    const custom = renames[tab.id]?.name; // '' は「名前なし」
    const renamed = custom != null;
    return h('span', {
      className: `title${renamed ? ' renamed' : ''}`,
      textContent: renamed ? custom : tab.title || tab.url || '新しいタブ',
    });
  };
  const savable = (tab) => /^(https?|file):/.test(tab.url ?? '');

  const tabRow = (tab) => {
    const renamed = renames[tab.id] != null;
    const row = h(
      'div',
      {
        className: `row tab${tab.active ? ' active' : ''}`,
        title: tab.url,
        dataset: { kind: 'tab', id: String(tab.id), index: String(tab.index) },
        draggable: true,
      },
      favicon(tab.url, tab.favIconUrl),
      tabTitle(tab),
      audioButton(tab),
      savable(tab) ? action('☆', 'ブックマークに追加', () => pinTab(tab)) : null,
      action('✎', '名前を変更(空にすると名前なし)', () => startRename(row)),
      renamed
        ? action('↺', '元の名前に戻す', () =>
            chrome.runtime.sendMessage({ type: 'rename', tabId: tab.id, name: null }),
          )
        : null,
      action('×', 'タブを閉じる', () => chrome.tabs.remove(tab.id)),
    );
    row.addEventListener('click', () => chrome.tabs.update(tab.id, { active: true }));
    row.addEventListener('auxclick', (event) => {
      if (event.button === 1) chrome.tabs.remove(tab.id);
    });
    return row;
  };

  // 分割ビューの 2 つのタブは 1 行にまとめ、左右それぞれをクリック・名前変更できるようにする
  const splitRow = (pair, splitId) => {
    const ids = pair.map((tab) => tab.id);
    const row = h(
      'div',
      {
        className: `row tab split${pair.some((tab) => tab.active) ? ' active' : ''}`,
        dataset: {
          kind: 'tab',
          id: String(ids[0]),
          ids: ids.join(','),
          index: String(pair[0].index),
          end: String(pair.at(-1).index),
          split: '1',
        },
        draggable: true,
      },
      ...pair.map((tab) => {
        const half = h(
          'div',
          { className: 'half', title: tab.url, dataset: { kind: 'tab', id: String(tab.id) } },
          favicon(tab.url, tab.favIconUrl),
          tabTitle(tab),
          audioButton(tab),
        );
        half.addEventListener('click', () => chrome.tabs.update(tab.id, { active: true }));
        return half;
      }),
      pair.every(savable) ? action('☆', 'ブックマークに追加', () => pinTab(pair[0])) : null,
      action('⊟', '分割を解除', () => splitApi.unsplit(splitId).catch(() => {})),
      action('×', '両方のタブを閉じる', () => chrome.tabs.remove(ids)),
    );
    row.addEventListener('auxclick', (event) => {
      if (event.button === 1) chrome.tabs.remove(ids);
    });
    return row;
  };

  // タブ (ブックマークから開いたタブは上の領域に表示しているので除く)
  const groups = [];
  const listed = allTabs
    .filter((t) => t.windowId === windowId && !linkedTabIds.has(t.id))
    .sort((a, b) => a.index - b.index);

  // Google Meet のタブはブックマークの下の「Current Meeting」にまとめる
  const meetingTabs = listed.filter(isMeetingTab);
  els.meeting.replaceChildren(
    ...(meetingTabs.length > 0
      ? [h('div', { className: 'section-title', textContent: 'Current Meeting' }), ...meetingTabs.map(tabRow)]
      : []),
  );

  for (const tab of listed.filter((t) => !isMeetingTab(t))) {
    const splitId = splitIdOf(tab);
    const last = groups.at(-1);
    if (splitId !== null && last?.splitId === splitId) last.tabs.push(tab);
    else groups.push({ splitId, tabs: [tab] });
  }
  const tabRows = groups.map((group) =>
    group.tabs.length > 1 ? splitRow(group.tabs, group.splitId) : tabRow(group.tabs[0]),
  );
  els.tabs.replaceChildren(...tabRows);

  // アーカイブ
  const archived = local.archived ?? [];
  els.archiveCount.textContent = String(archived.length);
  const archiveRows = archived.map((item) => {
    const row = h(
      'div',
      { className: 'row', title: item.url },
      favicon(item.url, item.favIconUrl),
      h('span', { className: 'title', textContent: item.title || item.url }),
      h('span', {
        className: 'time',
        textContent: new Date(item.archivedAt).toLocaleString('ja-JP', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
      }),
    );
    row.addEventListener('click', () => restoreArchived(item));
    return row;
  });
  if (archiveRows.length === 0) {
    archiveRows.push(h('div', { className: 'empty', textContent: 'アーカイブされたタブはありません' }));
  }
  els.archiveList.replaceChildren(...archiveRows);
}

// ------------------------------------------------------------------- 操作

async function toggleFolder(id) {
  const { openFolders = {} } = await chrome.storage.local.get('openFolders');
  if (openFolders[id]) {
    delete openFolders[id];
    await chrome.storage.local.set({ openFolders });
  } else {
    openFolders[id] = true;
    await chrome.storage.local.set({ openFolders, foldersOpenedAt: Date.now() });
  }
}

async function linkBookmark(bookmarkId, tabId) {
  const { links = {} } = await chrome.storage.session.get('links');
  links[bookmarkId] = tabId;
  await chrome.storage.session.set({ links });
  // すでに読み込み済みのタブを紐付けた場合は、その場で favicon を覚える
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.favIconUrl) await saveBookmarkFavicon(bookmarkId, tab.favIconUrl);
}

// Split View API は browser.tabs 名前空間で案内されているので、あればそちらを使う
const splitApi = globalThis.browser?.tabs ?? chrome.tabs;

// Arc のピン留めタブと同じく、開いていればそのタブへ切り替え、なければ開く
async function openBookmark(node) {
  const [{ links = {} }, { splitBookmarks = {} }] = await Promise.all([
    chrome.storage.session.get('links'),
    chrome.storage.local.get('splitBookmarks'),
  ]);
  let tab = links[node.id] != null ? await chrome.tabs.get(links[node.id]).catch(() => null) : null;
  if (!tab) {
    const split = splitBookmarks[node.id];
    if (split) {
      // 分割ビューとして登録したブックマーク: 2 つのタブを分割ビューで開く
      tab = await chrome.tabs.create({ url: node.url, windowId });
      try {
        await splitApi.create({ url: split.url, windowId, splitWithTabId: tab.id });
      } catch {
        // Split View API が無い Chrome では隣のタブとして開く
        await chrome.tabs.create({ url: split.url, windowId, index: tab.index + 1 });
      }
    } else {
      const tabs = await chrome.tabs.query({ windowId });
      const linked = linkedTabIdSet(links, tabs);
      tab =
        tabs.find((t) => t.url === node.url && !linked.has(t.id)) ??
        (await chrome.tabs.create({ url: node.url, windowId }));
    }
    await linkBookmark(node.id, tab.id);
  }
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== windowId) await chrome.windows.update(tab.windowId, { focused: true });
}

// ブックマークから開いたタブを閉じる。分割ビューなら相方も一緒に閉じる
async function closeBookmarkTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const splitId = splitIdOf(tab);
    const ids =
      splitId !== null ? (await chrome.tabs.query({ splitViewId: splitId })).map((t) => t.id) : [tabId];
    await chrome.tabs.remove(ids);
  } catch {
    // すでに閉じられている
  }
}

// タブをブックマークに登録する。分割ビューのタブなら 2 つまとめて 1 つのブックマークにする
async function bookmarkFromTab(tabId, destination, asTile) {
  const [tab, { renames = {} }] = await Promise.all([
    chrome.tabs.get(tabId),
    chrome.storage.local.get('renames'),
  ]);
  let primary = tab;
  let partner = null;
  const splitId = splitIdOf(tab);
  if (splitId !== null) {
    const pair = (await chrome.tabs.query({ splitViewId: splitId })).sort((a, b) => a.index - b.index);
    if (pair.length === 2) [primary, partner] = pair;
  }
  const savable = (t) => /^(https?|file):/.test(t.url ?? '');
  if (!savable(primary) || (partner && !savable(partner))) return;

  const nameOf = (t) => renames[t.id]?.name || stripBlank(t.title) || t.url;
  const bookmark = await chrome.bookmarks.create({
    ...destination,
    // タイルの並びに落としたら、同じくアイコンだけ (名前なし) で登録する
    title: asTile ? '' : partner ? `${nameOf(primary)} | ${nameOf(partner)}` : nameOf(primary),
    url: primary.url,
  });
  if (partner) {
    // ブックマーク自体は URL を 1 つしか持てないので、相方の URL は拡張機能側に保存する
    const { splitBookmarks = {} } = await chrome.storage.local.get('splitBookmarks');
    splitBookmarks[bookmark.id] = {
      url: partner.url,
      favIconUrl: usableFavicon(partner.favIconUrl) ? partner.favIconUrl : null,
    };
    await chrome.storage.local.set({ splitBookmarks });
  }
  await linkBookmark(bookmark.id, primary.id);
}

async function removeBookmark(id) {
  const [node] = await chrome.bookmarks.getSubTree(id);
  if (node.url) {
    await chrome.bookmarks.remove(id);
    return;
  }
  const count = (function countBookmarks(nodes) {
    return nodes.reduce((sum, n) => sum + (n.url ? 1 : countBookmarks(n.children ?? [])), 0);
  })(node.children ?? []);
  if (count > 0 && !confirm(`フォルダ「${node.title}」と中のブックマーク ${count} 件を削除しますか?`)) return;
  await chrome.bookmarks.removeTree(id);
}

// ブックマークの右クリックメニュー
let menu = null;
function closeMenu() {
  menu?.remove();
  menu = null;
}

function showMenu(x, y, items) {
  closeMenu();
  menu = h(
    'div',
    { className: 'menu' },
    ...items.map((entry) => {
      if (entry instanceof Node) return entry;
      const [label, handler] = entry;
      const item = h('button', { textContent: label });
      item.addEventListener('click', () => {
        closeMenu();
        handler();
      });
      return item;
    }),
  );
  document.body.append(menu);
  // 画面からはみ出さない位置に置く
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

async function setFolderColor(id, color) {
  const { folderColors = {} } = await chrome.storage.local.get('folderColors');
  if (color) folderColors[id] = color;
  else delete folderColors[id];
  await chrome.storage.local.set({ folderColors });
}

// メニュー内の色見本の列。先頭は「色なし (既定の文字色)」
function colorSwatches(id) {
  return h(
    'div',
    { className: 'swatches' },
    ...[null, ...FOLDER_COLORS].map((color) => {
      const swatch = h('button', {
        className: `swatch${color ? '' : ' none'}`,
        title: color ? color : '既定の色に戻す',
        style: color ? { background: color } : {},
      });
      swatch.addEventListener('click', () => {
        closeMenu();
        setFolderColor(id, color);
      });
      return swatch;
    }),
  );
}

els.bookmarks.addEventListener('contextmenu', async (event) => {
  const row = event.target.closest?.('.row[data-kind="bookmark"]');
  if (!row || editing) return;
  event.preventDefault();
  const { id } = row.dataset;
  const folder = row.classList.contains('folder');
  const { clientX, clientY } = event;
  const { links = {} } = await chrome.storage.session.get('links');
  const tabId = row.classList.contains('open') ? links[id] : null;
  showMenu(clientX, clientY, [
    ...(tabId != null
      ? [['タブを閉じる', () => closeBookmarkTab(tabId)]]
      : []),
    [
      '名前を変更',
      () => {
        const current = els.bookmarks.querySelector(`.row[data-kind="bookmark"][data-id="${CSS.escape(id)}"]`);
        if (current) startRename(current);
      },
    ],
    ...(folder ? [colorSwatches(id)] : []),
    [folder ? 'フォルダを削除' : 'ブックマークから削除', () => removeBookmark(id).catch(() => {})],
  ]);
});

document.addEventListener(
  'mousedown',
  (event) => {
    if (menu && !menu.contains(event.target)) closeMenu();
  },
  true,
);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});
window.addEventListener('blur', closeMenu);
$('main').addEventListener('scroll', closeMenu);

async function pinTab(tab) {
  if (!rootFolderId) return;
  await bookmarkFromTab(tab.id, { parentId: rootFolderId }, false);
}

async function restoreArchived(item) {
  await chrome.tabs.create({ url: item.url, windowId });
  const { archived = [] } = await chrome.storage.local.get('archived');
  const index = archived.findIndex((a) => a.url === item.url && a.archivedAt === item.archivedAt);
  if (index >= 0) archived.splice(index, 1);
  await chrome.storage.local.set({ archived });
}

// ダブルクリックで名前を変更 (タブ: 表示名 / ブックマーク: ブックマーク名)
function startRename(row) {
  const { kind, id } = row.dataset;
  const span = row.querySelector('.title');
  if (!span || editing) return;

  const initial = span.textContent;
  const input = h('input', { className: 'rename', value: initial, spellcheck: false });
  editing = true;
  row.classList.add('editing');
  // 入力欄でのテキスト選択をドラッグ扱いにしない
  const outer = row.closest('.row');
  if (outer) outer.draggable = false;
  span.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    try {
      if (commit && value !== initial) {
        if (kind === 'tab') {
          // 空にすると「名前なし」のタブになる
          await chrome.runtime.sendMessage({ type: 'rename', tabId: Number(id), name: value });
        } else if (value || !row.classList.contains('folder')) {
          // ブックマークも空にすればアイコンだけの表示になる (フォルダは名前必須)
          await chrome.bookmarks.update(id, { title: value });
        }
      }
    } finally {
      editing = false;
      dirty = false;
      schedule();
    }
  };

  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.isComposing) return; // 日本語入力の確定 Enter では閉じない
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  for (const type of ['click', 'dblclick', 'auxclick']) {
    input.addEventListener(type, (event) => event.stopPropagation());
  }
}

// 1 回目のクリックでタブが切り替わり行が描き直されるため、dblclick イベントではなく
// クリック回数 (event.detail) でダブルクリックを判定する
for (const container of [els.bookmarks, els.meeting, els.tabs]) {
  container.addEventListener('click', (event) => {
    if (event.detail !== 2) return;
    // 分割ビューの行では、クリックした側 (.half) のタブが対象になる
    const row = event.target.closest?.('[data-kind]');
    if (row) startRename(row);
  });
}

// 押してから離すまでの間に描き直すとクリックが成立しないので、その間は再描画を保留する
let pressTimer = null;
function release() {
  clearTimeout(pressTimer);
  if (!pressing) return;
  pressing = false;
  if (dirty && !editing && !dragging) {
    dirty = false;
    schedule();
  }
}
document.addEventListener(
  'mousedown',
  () => {
    pressing = true;
    // パネルの外でボタンを離すと mouseup が届かないので、時間でも解除する
    clearTimeout(pressTimer);
    pressTimer = setTimeout(release, 1500);
  },
  true,
);
for (const type of ['mouseup', 'dragend']) {
  document.addEventListener(type, release, true);
}

// ---------------------------------------------------------------- ドラッグ&ドロップ
// - タブ → タブ: 並べ替え
// - ブックマーク / フォルダ → ブックマーク領域: 並べ替え・フォルダへの移動
// - タブ → ブックマーク領域: その位置にブックマークとして登録
const dndArea = $('main');
const DROP_CLASSES = ['drop-before', 'drop-after', 'drop-left', 'drop-right', 'drop-into'];
const DROP_SELECTOR = DROP_CLASSES.map((name) => `.${name}`).join(', ');

function clearDropMarks() {
  for (const el of dndArea.querySelectorAll(DROP_SELECTOR)) el.classList.remove(...DROP_CLASSES);
}

// ドロップ先の要素に印を付ける。ドロップできない場所なら false
function markDropTarget(event) {
  clearDropMarks();
  const row = event.target.closest?.('.row[data-kind]');

  if (row?.dataset.kind === 'tab') {
    if (dragging.kind !== 'tab' || row.dataset.id === dragging.id) return false;
    const rect = row.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    // 行の中央に落とすと分割ビューにする (どちらもまだ分割されていないタブのときだけ)
    const canSplit =
      typeof splitApi.createSplit === 'function' && !dragging.split && !row.dataset.split;
    if (canSplit && ratio >= 0.3 && ratio <= 0.7) row.classList.add('drop-into');
    else row.classList.add(ratio < 0.5 ? 'drop-before' : 'drop-after');
    return true;
  }

  if (row?.dataset.kind === 'bookmark') {
    if (dragging.kind === 'bookmark' && row.dataset.id === dragging.id) return false;
    const rect = row.getBoundingClientRect();
    if (row.classList.contains('tile')) {
      row.classList.add(event.clientX < rect.left + rect.width / 2 ? 'drop-left' : 'drop-right');
    } else if (row.classList.contains('folder')) {
      // 上端・下端はフォルダの前後、中央はフォルダの中
      const ratio = (event.clientY - rect.top) / rect.height;
      row.classList.add(ratio < 0.25 ? 'drop-before' : ratio > 0.75 ? 'drop-after' : 'drop-into');
    } else {
      row.classList.add(event.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
    }
    return true;
  }

  // ブックマーク領域の余白: 末尾に追加
  if (els.bookmarks.contains(event.target) && rootFolderId) {
    els.bookmarks.classList.add('drop-into');
    return true;
  }
  return false;
}

// source のタブを target のタブの右に置いて分割ビューにする
async function splitTabs(sourceId, targetId) {
  let [source, target] = await Promise.all([chrome.tabs.get(sourceId), chrome.tabs.get(targetId)]);
  // 分割するには同じタブグループに属している必要がある
  if (source.groupId !== target.groupId) {
    if (target.groupId !== -1) await chrome.tabs.group({ groupId: target.groupId, tabIds: sourceId });
    else await chrome.tabs.ungroup(sourceId);
  }
  // 隣り合っている必要もある
  [source, target] = await Promise.all([chrome.tabs.get(sourceId), chrome.tabs.get(targetId)]);
  const index = source.index < target.index ? target.index : target.index + 1;
  if (source.index !== index) await chrome.tabs.move(sourceId, { index });
  await splitApi.createSplit([targetId, sourceId]);
  await chrome.tabs.update(sourceId, { active: true });
}

async function dropOnBookmarks(source, destination, asTile) {
  if (source.kind === 'bookmark') {
    await chrome.bookmarks.move(source.id, destination);
    return;
  }
  await bookmarkFromTab(Number(source.id), destination, asTile);
}

dndArea.addEventListener('dragstart', (event) => {
  const row = event.target.closest?.('.row[data-kind]');
  if (!row || editing) {
    event.preventDefault();
    return;
  }
  dragging = {
    kind: row.dataset.kind,
    id: row.dataset.id,
    index: Number(row.dataset.index),
    ids: (row.dataset.ids ?? row.dataset.id).split(','), // 分割ビューの行は 2 つのタブをまとめて動かす
    split: !!row.dataset.split,
  };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', row.dataset.id);
  row.classList.add('dragging');
});

dndArea.addEventListener('dragover', (event) => {
  if (!dragging || !markDropTarget(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});

dndArea.addEventListener('dragleave', (event) => {
  if (!dndArea.contains(event.relatedTarget)) clearDropMarks();
});

dndArea.addEventListener('drop', (event) => {
  if (!dragging) return;
  event.preventDefault();
  const source = dragging;
  const target = dndArea.querySelector(DROP_SELECTOR);
  if (!target) return;
  const before = target.classList.contains('drop-before') || target.classList.contains('drop-left');
  const into = target.classList.contains('drop-into');

  if (target === els.bookmarks) {
    dropOnBookmarks(source, { parentId: rootFolderId }, false).catch(() => {});
  } else if (target.dataset.kind === 'tab') {
    if (into) {
      splitTabs(Number(source.id), Number(target.dataset.id)).catch(() => {});
      return;
    }
    const ids = source.ids.map(Number);
    const from = source.index;
    const start = Number(target.dataset.index);
    const end = Number(target.dataset.end ?? start); // 分割ビューの行は 2 タブ分の幅がある
    // tabs.move の index は「移動元を取り除いた後」の位置
    const index =
      from < start ? (before ? start - ids.length : end - ids.length + 1) : before ? start : end + 1;
    if (index !== from) chrome.tabs.move(ids.length === 1 ? ids[0] : ids, { index }).catch(() => {});
  } else {
    // bookmarks.move / create の index は「移動元を取り除く前」の位置
    const destination = into
      ? { parentId: target.dataset.id }
      : { parentId: target.dataset.parent, index: Number(target.dataset.index) + (before ? 0 : 1) };
    dropOnBookmarks(source, destination, target.classList.contains('tile')).catch(() => {});
  }
});

dndArea.addEventListener('dragend', () => {
  dragging = null;
  clearDropMarks();
  dndArea.querySelector('.dragging')?.classList.remove('dragging');
  dirty = false;
  schedule();
});

$('#clear-tabs').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'clear', windowId }));
$('#new-tab').addEventListener('click', () => chrome.tabs.create({ windowId }));
$('#open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#archive-clear').addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (confirm('アーカイブ済みタブの一覧をすべて消去しますか?')) {
    chrome.storage.local.set({ archived: [] });
  }
});

// ------------------------------------------------------------------- 更新の購読

for (const name of [
  'onCreated',
  'onRemoved',
  'onUpdated',
  'onMoved',
  'onActivated',
  'onAttached',
  'onDetached',
  'onReplaced',
]) {
  chrome.tabs[name].addListener(schedule);
}

for (const name of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
  chrome.bookmarks[name].addListener(schedule);
}

chrome.storage.onChanged.addListener((changes) => {
  // seen は自動アーカイブ用に毎分更新されるだけなので再描画しない
  if (Object.keys(changes).some((key) => key !== 'seen')) schedule();
});

chrome.windows.getCurrent().then((win) => {
  windowId = win.id;
  render();
});
