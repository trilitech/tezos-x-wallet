import type { BackgroundRequest, BackgroundResponse, StoredSession } from './messages.js';

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function chainLabel(chainId: string): string {
  if (!chainId) return '—';
  const dec = parseInt(chainId, 16);
  if (!isNaN(dec)) return `${chainId} (${dec})`;
  return chainId;
}

// ── Rendu ────────────────────────────────────────────────────────────────────

function render(sessions: StoredSession[]): void {
  const container = $('sessions');
  const badge     = $('count');

  badge.textContent = `${sessions.length} site${sessions.length !== 1 ? 's' : ''}`;

  if (sessions.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <div class="icon">🔌</div>
        Aucun site connecté
      </div>`;
    return;
  }

  container.innerHTML = sessions.map((s) => `
    <div class="session" data-origin="${escapeHtml(s.origin)}">
      <div class="origin" title="${escapeHtml(s.origin)}">${escapeHtml(s.origin)}</div>

      <div class="field">
        <span class="label">EVM</span>
        <span class="value" title="${escapeHtml(s.evmAlias)}">${escapeHtml(shortAddr(s.evmAlias))}</span>
      </div>

      <div class="field">
        <span class="label">tz1</span>
        <span class="value" title="${escapeHtml(s.tz1Address)}">${escapeHtml(shortAddr(s.tz1Address))}</span>
      </div>

      <div class="field">
        <span class="label">Chain</span>
        <span class="chain-badge">${escapeHtml(chainLabel(s.chainId))}</span>
      </div>

      <div class="actions">
        <button class="btn-disconnect" data-origin="${escapeHtml(s.origin)}">
          Déconnecter
        </button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll<HTMLButtonElement>('.btn-disconnect').forEach((btn) => {
    btn.addEventListener('click', () => disconnect(btn.dataset.origin!));
  });
}

// ── Actions ──────────────────────────────────────────────────────────────────

function load(): void {
  const req: BackgroundRequest = { type: 'GET_SESSIONS' };
  chrome.runtime.sendMessage(req, (response: BackgroundResponse) => {
    if (chrome.runtime.lastError) {
      render([]);
      return;
    }
    if (response?.type === 'SESSIONS') render(response.sessions);
  });
}

function disconnect(origin: string): void {
  const req: BackgroundRequest = { type: 'DISCONNECT', origin };
  chrome.runtime.sendMessage(req, () => load());
}

// ── Démarrage ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const { version } = chrome.runtime.getManifest();
  $('version').textContent = `v${version}`;
  load();
});
