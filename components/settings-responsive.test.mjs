import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');const css=read('../app/settings.css');
test('settings navigation and internal panes use their own container width',()=>{
 assert.match(css,/\.settings-dialog-surface \{[^}]*container: settings-dialog \/ inline-size/);
 assert.match(css,/@container settings-dialog \(max-width: 960px\)/);
 assert.match(css,/\.config-panel-surface \{[^}]*container: config-panel \/ inline-size/);
 assert.match(css,/@container config-panel \(max-width: 720px\)/);
 assert.match(css,/@container config-detail \(max-width: 420px\)/);
});
test('execution engine follows the native settings content rail',()=>{
 const source=read('./ExecutionEngineSettings.tsx');assert.match(source,/className="settings-general settings-general-section"/);assert.doesNotMatch(source,/settings-general-section settings-card/);
});
test('usage provenance is a collapsed native details disclosure',()=>{
 const source=read('../enhancements/pi-usage-panel.js');assert.match(source,/<details class="pi-enh-usage-provenance">\s*<summary>统计口径与数据来源<\/summary>/);assert.match(source,/data-usage-provenance/);assert.doesNotMatch(source,/<details[^>]*class="pi-enh-usage-provenance"[^>]*open/);
});

test('phone keeps a left rail and fullscreen surface without a native section picker',()=>{
 const panel=read('./SettingsPanel.tsx');assert.doesNotMatch(panel,/settings-mobile-section-picker/);
 assert.match(css,/--settings-sidebar-track: 92px/);
 assert.match(css,/--settings-sidebar-track: 58px/);
 assert.match(css,/height: 100dvh/);
 assert.match(css,/padding-bottom: env\(safe-area-inset-bottom\)/);
 assert.doesNotMatch(css,/\.settings-section-tabs \{[^}]*display: none/);
});

test('enhancement parameter rows and action bars fit the content pane',()=>{
 const style=read('../app/enhancements.css');
 assert.match(style,/\.pi-enh-plugin-number-setting \{[^}]*flex-wrap: wrap[^}]*max-width: 100%/);
 assert.match(style,/@container settings-main \(max-width: 760px\) \{\s*\.pi-enh-plugins-toolbar/);
 assert.match(style,/\.pi-enh-plugins-actions \{[^}]*width: 100%[^}]*flex-wrap: wrap/);
});
