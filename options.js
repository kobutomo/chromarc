(async () => {
  const $ = (selector) => document.querySelector(selector);
  const enabled = $('#archive-enabled');
  const value = $('#archive-value');
  const unit = $('#archive-unit');
  const fontSize = $('#font-size');
  const fontSizeValue = $('#font-size-value');
  const preview = $('#preview');
  const folder = $('#bookmark-folder');

  const settings = await getSettings();

  // 自動アーカイブ
  enabled.checked = settings.archiveEnabled;
  value.value = settings.archiveValue;
  unit.value = settings.archiveUnit;
  const syncDisabled = () => {
    value.disabled = unit.disabled = !enabled.checked;
  };
  syncDisabled();

  enabled.addEventListener('change', () => {
    syncDisabled();
    saveSettings({ archiveEnabled: enabled.checked });
  });
  value.addEventListener('change', () => {
    const number = Number(value.value);
    if (!(number > 0)) {
      value.value = settings.archiveValue;
      return;
    }
    settings.archiveValue = number;
    saveSettings({ archiveValue: number });
  });
  unit.addEventListener('change', () => saveSettings({ archiveUnit: unit.value }));

  // 文字サイズ
  const showFontSize = () => {
    fontSizeValue.textContent = `${fontSize.value}px`;
    preview.style.fontSize = `${fontSize.value}px`;
  };
  fontSize.value = settings.fontSize;
  showFontSize();
  fontSize.addEventListener('input', () => {
    showFontSize();
    saveSettings({ fontSize: Number(fontSize.value) });
  });

  // ブックマークフォルダ
  folder.append(new Option('ブックマークバー(既定)', ''));
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      if (node.url) continue;
      folder.append(new Option(`${'　'.repeat(depth)}${node.title || '(無題のフォルダ)'}`, node.id));
      walk(node.children ?? [], depth + 1);
    }
  };
  const tree = await chrome.bookmarks.getTree();
  walk(tree[0]?.children ?? [], 0);
  folder.value = settings.bookmarkFolderId ?? '';
  if (folder.selectedIndex < 0) folder.value = '';
  folder.addEventListener('change', () => saveSettings({ bookmarkFolderId: folder.value || null }));
})();
