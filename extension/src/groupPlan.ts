import * as vscode from 'vscode';
import type { GroupPlan } from './serveClient';
import { runCtl } from './util';

const size = (plan: GroupPlan): string => (plan.moves.length === 1 ? '1 move' : `${plan.moves.length} moves`);

/**
 * The user's side of a proposed regrouping. A session may ask for the tree to change, and a skill can
 * call `ctl group-plan`, but only the user may apply it. The button click is the confirmation. A
 * single click applies the proposal. This owns the title-bar button, the notification and the context
 * key that hides the button while nothing is waiting. The backend
 * re-checks the whole plan when it applies it, so one that went stale while it sat here is refused
 * rather than half-applied.
 */
export class GroupPlanWatcher {
  private current?: GroupPlan;
  private announced = 0;      // `created` of the plan already announced; 0 = nothing announced
  private shown = false;      // the context key's value, so it is only written when it changes

  /** Every snapshot: keep the button in step, and announce a proposal once. */
  update(plan?: GroupPlan | null): void {
    this.current = plan?.moves?.length ? plan : undefined;
    if (!!this.current !== this.shown) {
      this.shown = !!this.current;
      void vscode.commands.executeCommand('setContext', 'pengupool.groupPlanPending', this.shown);
    }
    if (!this.current || this.current.created === this.announced) { return; }
    this.announced = this.current.created;
    const labels = this.current.moves.map((m) => m.label).join(', ');
    const note = this.current.note ? `\n\nWhy: ${this.current.note}` : '';
    void vscode.window.showInformationMessage(
      `PenguPool: a regrouping (${size(this.current)}): ${labels}${note}`,
      'Apply', 'Discard',
    ).then((choice) => {
      if (choice === 'Apply') { void this.apply(); }
      else if (choice === 'Discard') { void this.discard(); }
    });
  }

  /** The click is the confirmation, so it applies the pending proposal directly. */
  async apply(): Promise<void> {
    const plan = this.current;
    if (!plan) {
      void vscode.window.showInformationMessage('PenguPool: no regrouping is waiting.');
      return;
    }
    await this.settle(['group-apply'], 'applied');
  }

  /** Drop the proposal without touching the group tree. */
  async discard(): Promise<void> {
    await this.settle(['group-apply', '--discard'], 'discarded');
  }

  /** The user's one-shot write, reported either way. `did` is how the message names it ("applied"). */
  private async settle(args: string[], did: string): Promise<void> {
    const res = await runCtl(args);
    if (res.code !== 0) {
      void vscode.window.showErrorMessage(`PenguPool: ${res.stderr || `the regrouping could not be ${did}`}`);
      return;
    }
    this.announced = 0;
    this.update(undefined);            // the backend consumed it: drop the button until a snapshot agrees
    void vscode.window.showInformationMessage(`PenguPool: ${res.stdout || `regrouping ${did}`}`);
  }
}
