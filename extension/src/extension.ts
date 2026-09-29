import * as vscode from 'vscode';
import { ServeClient } from './serveClient';
import { SessionsProvider } from './sessionsTree';
import { HintsProvider } from './hintsView';
import { TerminalManager } from './terminals';
import { MapPanel } from './mapPanel';
import { LogPanel } from './logPanel';
import { registerCommands } from './commands';
import { DefaultLayout } from './defaultLayout';
import { SessionsView } from './sessionsView';
import { bothHarnessesContext } from './harness';
import { backendCommand, installCommand, isRemote, remoteHost, resolveRemoteCommand, sshArgs } from './remote';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('PenguPool');
  const provider = new SessionsProvider();
  const terminals = new TerminalManager(context);
  const client = new ServeClient(output);
  let setupNoticeShown = false;
  const tree = new SessionsView(provider);
  const piTree = new SessionsView(provider, 'pi');   // shown only while both harnesses run
  const webviewOptions = { webviewOptions: { retainContextWhenHidden: true } };
  const sessions = vscode.window.registerWebviewViewProvider('pengupoolSessions', tree, webviewOptions);
  const piSessions = vscode.window.registerWebviewViewProvider('pengupoolPiSessions', piTree, webviewOptions);
  const syncBoth = bothHarnessesContext();
  const hints = vscode.window.registerTreeDataProvider('pengupoolHints', new HintsProvider());
  const layout = new DefaultLayout(context, tree, terminals);

  client.onSnapshot((snap) => {
    provider.update(snap);
    syncBoth(snap.roots);
    tree.update(snap);
    piTree.update(snap);
    terminals.reconcile(snap.roots);        // bind freshly launched terminals to their sessionId
    layout.update(snap);
    MapPanel.showIfOpen()?.update(snap);
    LogPanel.showIfOpen()?.update(snap);
  });
  context.subscriptions.push(client.onSpawnError((err) => {
    if (setupNoticeShown) { return; }
    setupNoticeShown = true;
    if (isRemote()) {   // the backend is missing on that host, not on this machine
      void vscode.window.showErrorMessage(
        `PenguPool is not set up on ${remoteHost()}: ${err.message}`,
        'Install on this host', 'Open setting',
      ).then((choice) => {
        if (choice === 'Install on this host') {
          void vscode.commands.executeCommand('pengupool.installRemote');
        } else if (choice === 'Open setting') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'pengupool.remoteHost');
        }
      });
      return;
    }
    void vscode.window.showErrorMessage(
      `PenguPool could not start its CLI (${err.message}). Install the backend or set pengupool.command.`,
      'Setup guide', 'Open setting',
    ).then((choice) => {
      if (choice === 'Setup guide') {
        void vscode.env.openExternal(vscode.Uri.parse('https://github.com/nduwork/pengutool/blob/main/extension/README.md#setup'));
      } else if (choice === 'Open setting') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'pengupool.command');
      }
    });
  }));

  registerCommands(context, { provider, terminals, tree });

  context.subscriptions.push(
    output, tree, piTree, sessions, piSessions, hints, terminals, client, layout,
    vscode.commands.registerCommand('pengupool.showMap', () => MapPanel.toggle(context, client.lastSnapshot)),
    vscode.commands.registerCommand('pengupool.showLog', () => LogPanel.toggle(client.lastSnapshot)),
    vscode.commands.registerCommand('pengupool.refresh', () => client.restart()),
    // Set the backend up on the remote host over the same ssh the rest of the extension uses. Interactive
    // on purpose: the installer asks before installing tmux or an agent CLI, and this is where a host key
    // gets confirmed, which a background connection never does.
    vscode.commands.registerCommand('pengupool.installRemote', async () => {
      const host = remoteHost();
      if (!host) {
        void vscode.window.showInformationMessage(
          'PenguPool: set `pengupool.remoteHost` to an ssh host before installing on one.');
        return;
      }
      const term = vscode.window.createTerminal({
        name: `PenguPool setup · ${host}`,
        shellPath: 'ssh',
        shellArgs: [...sshArgs(true), host, installCommand()],
        isTransient: false,
      });
      term.show();
      const pick = await vscode.window.showInformationMessage(
        `Installing PenguPool on ${host}. Reload this window when it finishes, so the extension picks up the new backend.`,
        'Reload Window',
      );
      if (pick === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),
  );

  if (isRemote()) {
    // Ask where the remote CLI is before the first spawn: no non-interactive ssh has ~/.local/bin on
    // PATH, which is where the installer puts it.
    await resolveRemoteCommand();
    output.appendLine(`[pengupool] remote host ${remoteHost()}, backend ${backendCommand()}`);
  }
  client.start();
}

export function deactivate(): void { /* subscriptions dispose the client + terminals */ }
