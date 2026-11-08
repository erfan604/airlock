// The owner's book file control (AIR-326): load `book.vault.json` into memory so the look-alike check and the remember action work against
// a private book, and save the new file after a change. The file never leaves the browser.
import { useEffect, useState } from 'react';
import { getVault, onVaultChange, setVault, vaultFromText, vaultNeedsSaving, vaultText } from '../chain/vaultStore.ts';

export function VaultDrop({ onLoaded }: { onLoaded?(): void }) {
  const [, tick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onVaultChange(() => tick((n) => n + 1)), []);
  const vault = getVault();

  async function load(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    try {
      setVault(vaultFromText(await file.text()));
      setError(null);
      onLoaded?.();
    } catch {
      setError('That file is not a book file.');
    }
  }
  function save(): void {
    if (vault === null) return;
    const url = URL.createObjectURL(new Blob([vaultText(vault)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'book.vault.json';
    a.click();
    URL.revokeObjectURL(url);
    setVault(vault, false);
  }
  return (
    <section className="approvals-book" data-testid="vault-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void load(e.dataTransfer.files[0]); }}>
      <p className="approvals-empty" data-testid="vault-state">
        {vault === null ? 'Your book file is not loaded. Drop it here to check payees against your book. It stays in this browser.' : 'Your book file is loaded in this browser.'}
      </p>
      <input type="file" accept="application/json,.json" data-testid="vault-input" onChange={(e) => void load(e.target.files?.[0])} />
      {vaultNeedsSaving() ? (
        <button type="button" className="approvals-save-book" data-testid="vault-save" onClick={save}>
          Save your updated book file
        </button>
      ) : null}
      {error !== null ? (
        <p className="approvals-error" role="alert" data-testid="vault-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
