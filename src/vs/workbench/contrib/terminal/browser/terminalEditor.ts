/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { IActionViewItem } from 'vs/base/browser/ui/actionbar/actionbar';
import { Action, IAction, Separator, SubmenuAction } from 'vs/base/common/actions';
import { CancellationToken } from 'vs/base/common/cancellation';
import { Codicon } from 'vs/base/common/codicons';
import { FindReplaceState } from 'vs/editor/contrib/find/findState';
import { localize } from 'vs/nls';
import { DropdownWithPrimaryActionViewItem } from 'vs/platform/actions/browser/dropdownWithPrimaryActionViewItem';
import { IMenu, IMenuActionOptions, IMenuService, MenuId, MenuItemAction } from 'vs/platform/actions/common/actions';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IEditorOptions } from 'vs/platform/editor/common/editor';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ICreateTerminalOptions, ITerminalProfile, TerminalLocation } from 'vs/platform/terminal/common/terminal';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { EditorPane } from 'vs/workbench/browser/parts/editor/editorPane';
import { IEditorOpenContext } from 'vs/workbench/common/editor';
import { ITerminalEditorService, ITerminalService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { TerminalEditorInput } from 'vs/workbench/contrib/terminal/browser/terminalEditorInput';
import { TerminalFindWidget } from 'vs/workbench/contrib/terminal/browser/terminalFindWidget';
import { TerminalTabContextMenuGroup } from 'vs/workbench/contrib/terminal/browser/terminalMenus';
import { ITerminalProfileResolverService, KEYBINDING_CONTEXT_TERMINAL_FIND_VISIBLE, TerminalCommandId } from 'vs/workbench/contrib/terminal/common/terminal';
import { ITerminalContributionService } from 'vs/workbench/contrib/terminal/common/terminalExtensionPoints';
import { terminalStrings } from 'vs/workbench/contrib/terminal/common/terminalStrings';
import { IEditorGroup } from 'vs/workbench/services/editor/common/editorGroupsService';
import { isLinux, isMacintosh } from 'vs/base/common/platform';
import { BrowserFeatures } from 'vs/base/browser/canIUse';
import { createAndFillInContextMenuActions } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { INotificationService } from 'vs/platform/notification/common/notification';

const xtermSelector = '.terminal.xterm';
const findWidgetSelector = '.simple-find-part-wrapper';

export class TerminalEditor extends EditorPane {

	public static readonly ID = 'terminalEditor';

	private _parentElement: HTMLElement | undefined;

	private _editorInput?: TerminalEditorInput = undefined;

	private _lastDimension?: dom.Dimension;

	private readonly _dropdownMenu: IMenu;

	private _findWidget: TerminalFindWidget;
	private _findWidgetVisible: IContextKey<boolean>;
	private _findState: FindReplaceState;

	private readonly _instanceMenu: IMenu;

	private _cancelContextMenu: boolean = false;

	get findState(): FindReplaceState { return this._findState; }

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ITerminalEditorService private readonly _terminalEditorService: ITerminalEditorService,
		@ITerminalProfileResolverService private readonly _terminalProfileResolverService: ITerminalProfileResolverService,
		@ITerminalContributionService private readonly _terminalContributionService: ITerminalContributionService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IMenuService menuService: IMenuService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@INotificationService private readonly _notificationService: INotificationService
	) {
		super(TerminalEditor.ID, telemetryService, themeService, storageService);
		this._findState = new FindReplaceState();
		this._findWidget = instantiationService.createInstance(TerminalFindWidget, this._findState);
		this._findWidgetVisible = KEYBINDING_CONTEXT_TERMINAL_FIND_VISIBLE.bindTo(contextKeyService);
		this._dropdownMenu = this._register(menuService.createMenu(MenuId.TerminalNewDropdownContext, contextKeyService));
		this._instanceMenu = this._register(menuService.createMenu(MenuId.TerminalInstanceContext, contextKeyService));
	}

	override async setInput(newInput: TerminalEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken) {
		this._editorInput?.terminalInstance?.detachFromElement();
		this._editorInput = newInput;
		await super.setInput(newInput, options, context, token);
		this._editorInput.terminalInstance?.attachToElement(this._parentElement!);
		if (this._lastDimension) {
			this.layout(this._lastDimension);
		}
		this._editorInput.terminalInstance?.setVisible(true);
		if (this._editorInput.terminalInstance) {
			// since the editor does not monitor focus changes, for ex. between the terminal
			// panel and the editors, this is needed so that the active instance gets set
			// when focus changes between them.
			this._register(this._editorInput.terminalInstance.onFocused(() => this._setActiveInstance()));
		}
	}

	private _setActiveInstance(): void {
		if (!this._editorInput?.terminalInstance) {
			return;
		}
		this._terminalEditorService.setActiveInstance(this._editorInput.terminalInstance);
	}

	override focus() {
		this._editorInput?.terminalInstance?.focus();
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention
	protected createEditor(parent: HTMLElement): void {
		this._parentElement = parent;
		this._registerListeners();
	}

	private _registerListeners(): void {
		if (!this._parentElement) {
			return;
		}
		this._register(dom.addDisposableListener(this._parentElement, 'mousedown', async (event: MouseEvent) => {
			if (this._terminalEditorService.instances.length === 0) {
				return;
			}

			if (event.which === 2 && isLinux) {
				// Drop selection and focus terminal on Linux to enable middle button paste when click
				// occurs on the selection itself.
				const terminal = this._terminalEditorService.activeInstance;
				if (terminal) {
					terminal.focus();
				}
			} else if (event.which === 3) {
				const rightClickBehavior = this._terminalService.configHelper.config.rightClickBehavior;
				if (rightClickBehavior === 'copyPaste' || rightClickBehavior === 'paste') {
					const terminal = this._terminalEditorService.activeInstance;
					if (!terminal) {
						return;
					}

					// copyPaste: Shift+right click should open context menu
					if (rightClickBehavior === 'copyPaste' && event.shiftKey) {
						this._openContextMenu(event);
						return;
					}

					if (rightClickBehavior === 'copyPaste' && terminal.hasSelection()) {
						await terminal.copySelection();
						terminal.clearSelection();
					} else {
						if (BrowserFeatures.clipboard.readText) {
							terminal.paste();
						} else {
							this._notificationService.info(`This browser doesn't support the clipboard.readText API needed to trigger a paste, try ${isMacintosh ? '⌘' : 'Ctrl'}+V instead.`);
						}
					}
					// Clear selection after all click event bubbling is finished on Mac to prevent
					// right-click selecting a word which is seemed cannot be disabled. There is a
					// flicker when pasting but this appears to give the best experience if the
					// setting is enabled.
					if (isMacintosh) {
						setTimeout(() => {
							terminal.clearSelection();
						}, 0);
					}
					this._cancelContextMenu = true;
				}
			}
		}));
		this._register(dom.addDisposableListener(this._parentElement, dom.EventType.CONTEXT_MENU, e => {
			const rightClickBehavior = this._terminalService.configHelper.config.rightClickBehavior;
			if (e.button === 2 && rightClickBehavior !== 'copyPaste' && rightClickBehavior !== 'paste') {
				this._openContextMenu(e);
				e.preventDefault();
			}
		}));
		this._register(dom.addDisposableListener(this._parentElement, 'contextmenu', (event: MouseEvent) => {
			if (!this._cancelContextMenu) {
				this._openContextMenu(event);
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			this._cancelContextMenu = false;
		}));
	}

	private _openContextMenu(event: MouseEvent): void {
		const standardEvent = new StandardMouseEvent(event);

		const anchor: { x: number, y: number } = { x: standardEvent.posx, y: standardEvent.posy };
		const actions: IAction[] = [];

		const actionsDisposable = createAndFillInContextMenuActions(this._instanceMenu, undefined, actions);

		this._contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			getActionsContext: () => this._parentElement,
			onHide: () => actionsDisposable.dispose()
		});
	}

	layout(dimension: dom.Dimension): void {
		this._editorInput?.terminalInstance?.layout(dimension);
		this._lastDimension = dimension;
	}

	override setVisible(visible: boolean, group?: IEditorGroup): void {
		super.setVisible(visible, group);
		return this._editorInput?.terminalInstance?.setVisible(visible);
	}

	override getActionViewItem(action: IAction): IActionViewItem | undefined {
		switch (action.id) {
			case TerminalCommandId.CreateWithProfileButton: {
				const actions = this._getTabActionBarArgs(this._terminalService.availableProfiles);
				const button = this._instantiationService.createInstance(DropdownWithPrimaryActionViewItem, actions.primaryAction, actions.dropdownAction, actions.dropdownMenuActions, actions.className, this._contextMenuService);
				return button;
			}
		}
		return super.getActionViewItem(action);
	}

	private _getTabActionBarArgs(profiles: ITerminalProfile[]): {
		primaryAction: MenuItemAction,
		dropdownAction: IAction,
		dropdownMenuActions: IAction[],
		className: string,
		dropdownIcon?: string
	} {
		const dropdownActions: IAction[] = [];
		const submenuActions: IAction[] = [];

		const defaultProfileName = this._terminalProfileResolverService.defaultProfileName;
		for (const p of profiles) {
			const isDefault = p.profileName === defaultProfileName;
			const options: IMenuActionOptions = {
				arg: {
					config: p,
					target: TerminalLocation.Editor
				} as ICreateTerminalOptions,
				shouldForwardArgs: true
			};
			if (isDefault) {
				dropdownActions.unshift(this._instantiationService.createInstance(MenuItemAction, { id: TerminalCommandId.NewWithProfile, title: localize('defaultTerminalProfile', "{0} (Default)", p.profileName), category: TerminalTabContextMenuGroup.Profile }, undefined, options));
				submenuActions.unshift(this._instantiationService.createInstance(MenuItemAction, { id: TerminalCommandId.Split, title: localize('defaultTerminalProfile', "{0} (Default)", p.profileName), category: TerminalTabContextMenuGroup.Profile }, undefined, options));
			} else {
				dropdownActions.push(this._instantiationService.createInstance(MenuItemAction, { id: TerminalCommandId.NewWithProfile, title: p.profileName.replace(/[\n\r\t]/g, ''), category: TerminalTabContextMenuGroup.Profile }, undefined, options));
				submenuActions.push(this._instantiationService.createInstance(MenuItemAction, { id: TerminalCommandId.Split, title: p.profileName.replace(/[\n\r\t]/g, ''), category: TerminalTabContextMenuGroup.Profile }, undefined, options));
			}
		}

		// TODO: Support contributed profiles with editor target
		for (const contributed of this._terminalContributionService.terminalProfiles) {
			dropdownActions.push(new Action(TerminalCommandId.NewWithProfile, contributed.title.replace(/[\n\r\t]/g, ''), undefined, true, () => this._terminalService.createContributedTerminalProfile(contributed.extensionIdentifier, contributed.id, {
				isSplitTerminal: false,
				target: TerminalLocation.Editor
			})));
			submenuActions.push(new Action(TerminalCommandId.NewWithProfile, contributed.title.replace(/[\n\r\t]/g, ''), undefined, true, () => this._terminalService.createContributedTerminalProfile(contributed.extensionIdentifier, contributed.id, {
				isSplitTerminal: true,
				target: TerminalLocation.Editor
			})));
		}

		if (dropdownActions.length > 0) {
			dropdownActions.push(new SubmenuAction('split.profile', 'Split...', submenuActions));
			dropdownActions.push(new Separator());
		}

		for (const [, configureActions] of this._dropdownMenu.getActions()) {
			for (const action of configureActions) {
				// make sure the action is a MenuItemAction
				if ('alt' in action) {
					dropdownActions.push(action);
				}
			}
		}

		const primaryAction = this._instantiationService.createInstance(
			MenuItemAction,
			{
				id: TerminalCommandId.CreateTerminalEditor,
				title: localize('terminal.new', "New Terminal"),
				icon: Codicon.plus
			},
			{
				id: 'workbench.action.splitEditor',
				title: terminalStrings.split.value,
				icon: Codicon.splitHorizontal
			},
			undefined);

		const dropdownAction = new Action('refresh profiles', 'Launch Profile...', 'codicon-chevron-down', true);
		return { primaryAction, dropdownAction, dropdownMenuActions: dropdownActions, className: 'terminal-tab-actions' };
	}

	focusFindWidget() {
		if (this._parentElement && !this._parentElement?.querySelector(findWidgetSelector)) {
			this._parentElement.querySelector(xtermSelector)!.appendChild(this._findWidget.getDomNode());
		}
		this._findWidgetVisible.set(true);
		const activeInstance = this._terminalEditorService.activeInstance;
		if (activeInstance && activeInstance.hasSelection() && activeInstance.selection!.indexOf('\n') === -1) {
			this._findWidget.reveal(activeInstance.selection);
		} else {
			this._findWidget.reveal();
		}
	}

	hideFindWidget() {
		this._findWidgetVisible.reset();
		this.focus();
		this._findWidget.hide();
	}

	showFindWidget() {
		const activeInstance = this._terminalEditorService.activeInstance;
		if (activeInstance && activeInstance.hasSelection() && activeInstance.selection!.indexOf('\n') === -1) {
			this._findWidget.show(activeInstance.selection);
		} else {
			this._findWidget.show();
		}
	}

	getFindWidget(): TerminalFindWidget {
		return this._findWidget;
	}
}
