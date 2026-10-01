import * as vscode from 'vscode';
import type { GroupPlan } from './serveClient';
import { runCtl } from './util';

const size = (plan: GroupPlan): string => (plan.moves.length === 1 ? '1 move' : `${plan.moves.length} moves`);

/**
 * The user's side of a proposed regrouping. A session may ask for the tree to change — a skill can call
 * `ctl group-plan` — but only the user may apply it, so this owns the confirmation prompt, the
 * `pengupool.groupPlan` button and the context key that hides it while nothing is waiting. The backend
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
    void vscode.window.showInformationMessage(
      `PenguPool: a session proposed a regrouping (${size(this.current)}). Nothing moves until you approve it.`,
      'Review', 'Discard',
    ).then((choice) => {
      if (choice === 'Review') { void this.review(); }
      else if (choice === 'Discard') { void this.discard(); }
    });
  }

  /** Show the whole proposal, then apply it only if the user approves the tree it produces. */
  async review(): Promise<void> {
    const plan = this.current;
    if (!plan) {
      void vscode.window.showInformationMessage('PenguPool: no regrouping is waiting.');
      return;
    }
    const detail = plan.moves.map((m) => `• ${m.label}`).join('\n')
      + (plan.note ? `\n\nWhy: ${plan.note}` : '')
      + '\n\nGrouping decides who may message whom, so a session may propose a regroup but never apply one.';
    const ok = await vscode.window.showWarningMessage(
      `Apply this regrouping? ${size(plan)}`, { modal: true, detail }, 'Apply');
    if (ok !== 'Apply') { return; }
    const res = await runCtl(['group-apply']);
    if (res.code !== 0) {
      void vscode.window.showErrorMessage(`PenguPool: ${res.stderr || 'the regrouping could not be applied'}`);
      return;
    }
    this.announced = 0;
    this.update(undefined);            // the backend consumed it: drop the button until a snapshot agrees
    void vscode.window.showInformationMessage(`PenguPool: ${res.stdout || 'regrouping applied'}`);
  }

  /** Drop the proposal without touching the group tree. */
  async discard(): Promise<void> {
    const res = await runCtl(['group-apply', '--discard']);
    if (res.code !== 0) {
      void vscode.window.showErrorMessage(`PenguPool: ${res.stderr || 'the regrouping could not be discarded'}`);
      return;
    }
    this.announced = 0;
    this.update(undefined);
    void vscode.window.showInformationMessage(`PenguPool: ${res.stdout || 'proposal discarded'}`);
  }
}
