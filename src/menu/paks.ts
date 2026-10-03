/**
 * "Use your own Quake files": the player's own id1 pak0.pak / pak1.pak, loaded through the
 * content part's id-pak loader. They stay in this browser (IndexedDB), are never uploaded
 * and never advertised to a room; they only change how things look and sound
 * (DESIGN.md "Licensing", "Content packs").
 *
 * Licence: GPL-2.0-or-later.
 */
import { h, clear, fmtKB } from './dom.js';
import { pixelText } from './pixelfont.js';
import type { MenuCtx, Screen } from './types.js';

export function paksScreen(ctx: MenuCtx): Screen {
  const loader = ctx.deps.idPaks;
  const state = h('div.pakstate', { 'aria-live': 'polite' });
  const input = h('input', { type: 'file', accept: '.pak,.PAK', multiple: true, hidden: true });
  const pick = h('button.cta', { type: 'button', disabled: !loader }, 'Choose pak files');
  const drop = h('div.drop', { tabindex: '-1' },
    pixelText('pak0.pak  pak1.pak', { px: 3, tone: 'dim', shadow: false }),
    h('p', {}, 'Drop the files here, or'), pick, input,
    h('small', {}, 'They are in the id1 folder of your Quake install (Steam: steamapps/common/Quake/id1; the 2021 re-release keeps them in rerelease/id1).'));

  async function paint(): Promise<void> {
    clear(state);
    if (!loader) { state.append(h('p.warn', {}, 'Loading your own paks is not available in this build yet.')); return; }
    try {
      const s = await loader.status();
      if (!s.loaded) { state.append(h('p', {}, 'No Quake files loaded. You are seeing LibreQuake’s free art.')); return; }
      const forget = h('button.ghost.small', { type: 'button' }, 'Remove them from this browser');
      forget.addEventListener('click', async () => { await loader.forget(); ctx.toast('Removed. LibreQuake’s art is back on next load.'); void paint(); });
      state.append(
        h('p.ok', {}, 'Loaded. Your Quake art and sounds are used from the next match on.'),
        h('ul.paklist', {}, ...s.files.map((f) => h('li', {}, h('b', {}, f.name), h('small', {}, fmtKB(f.bytes))))),
        forget,
      );
    } catch (err) {
      state.append(h('p.err', {}, `Could not read the stored files: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  async function load(files: File[]): Promise<void> {
    if (!loader) return;
    const paks = files.filter((f) => /\.pak$/i.test(f.name));
    if (!paks.length) { ctx.toast('Those are not .pak files. Look for pak0.pak in id1.'); return; }
    pick.disabled = true;
    pick.textContent = 'Reading…';
    try {
      const r = await loader.load(paks);
      ctx.toast(r.message);
    } catch (err) {
      ctx.toast(`Could not load them: ${err instanceof Error ? err.message : String(err)}`);
    }
    pick.disabled = false;
    pick.textContent = 'Choose pak files';
    void paint();
  }

  pick.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { void load([...(input.files ?? [])]); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); void load([...(e.dataTransfer?.files ?? [])]); });

  const el = h('section.screen.paks', { 'aria-labelledby': 'pak-title' },
    h('div.screen-head', {}, h('h2#pak-title', {}, pixelText('Your Quake paks', { px: 4, bold: true }))),
    h('div.pak-grid', {},
      h('div.col.prose', {},
        h('p.lead', {}, 'Own Quake? Load its pak files and play with id Software’s original models, textures and sounds.'),
        h('p', {}, 'The files stay in this browser. They are not uploaded, not shared with other players, and nobody else needs them: everyone plays the same game, you just see your own art.'),
        h('p', {}, 'Maps, physics and rules come from the server, so loading paks never puts you out of step with the room. id’s own maps are not playable here, because they cannot be shared with players who do not own Quake.'),
        h('p.fine', {}, 'Without paks you see LibreQuake, a free replacement for Quake’s art.'),
      ),
      h('div.col', {}, drop, state),
    ),
  );

  return { el, show() { void paint(); } };
}
