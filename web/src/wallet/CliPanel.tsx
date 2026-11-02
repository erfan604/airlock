// The CLI approve panel (cut ladder rung 7): the same card data as a `near` command the owner runs in a terminal, shown when no allowed
// wallet is available or an approval failed twice. It is text only: there is no button, no input and nothing runs from the page.
import type { ApproveArgs } from '../approvals/cardModel.ts';
import { APPROVE_PREPAID_TGAS } from './approve.ts';

/** The line `scripts/approve-cli.sh <no>` prints (AIR-087). Throws when a value holds a single quote: the shell quoting would break. */
export function approveCliCommand(a: ApproveArgs, o: { contractId: string; ownerId: string }): string {
  const json = JSON.stringify({ id: a.id, to: a.to, asset: a.asset, amount: a.amount, why: a.why, book: a.book });
  if (json.includes("'")) throw new Error('a value holds a single quote: use scripts/approve-cli.sh');
  return `near contract call-function as-transaction ${o.contractId} approve json-args '${json}' prepaid-gas '${APPROVE_PREPAID_TGAS} Tgas' attached-deposit '1 yoctoNEAR' sign-as ${o.ownerId} network-config testnet sign-with-keychain send`;
}

export type CliPanelProps = { args: ApproveArgs; contractId: string; ownerId: string };

export function CliPanel({ args, contractId, ownerId }: CliPanelProps) {
  let command: string;
  try {
    command = approveCliCommand(args, { contractId, ownerId });
  } catch {
    return (
      <section className="cli-panel" data-testid="cli-panel" aria-label="Approve from a terminal">
        <h3 className="card-label">Approve from a terminal</h3>
        <p className="cli-text">{`Run scripts/approve-cli.sh ${args.id} in the repository: this request holds a character the pasted command cannot carry.`}</p>
      </section>
    );
  }
  return (
    <section className="cli-panel" data-testid="cli-panel" aria-label="Approve from a terminal">
      <h3 className="card-label">Approve from a terminal</h3>
      <p className="cli-text">Run this in a terminal that holds the owner key. It names the same five values as the card.</p>
      <pre className="cli-command" data-testid="cli-command">
        {command}
      </pre>
    </section>
  );
}
