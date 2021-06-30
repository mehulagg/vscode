/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { Event, Emitter } from 'vs/base/common/event';
import { Disposable, toDisposable } from 'vs/base/common/lifecycle';
import { IExtensionManagementService, IExtensionIdentifier, IGlobalExtensionEnablementService, ENABLED_EXTENSIONS_STORAGE_PATH, DISABLED_EXTENSIONS_STORAGE_PATH } from 'vs/platform/extensionManagement/common/extensionManagement';
import { IWorkbenchExtensionEnablementService, EnablementState, IExtensionManagementServerService, IWorkbenchExtensionManagementService, IExtensionManagementServer } from 'vs/workbench/services/extensionManagement/common/extensionManagement';
import { areSameExtensions, BetterMergeId, getExtensionDependencies } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IExtension, isAuthenticaionProviderExtension, isLanguagePackExtension } from 'vs/platform/extensions/common/extensions';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { StorageManager } from 'vs/platform/extensionManagement/common/extensionEnablementService';
import { webWorkerExtHostConfig } from 'vs/workbench/services/extensions/common/extensions';
import { IUserDataSyncAccountService } from 'vs/platform/userDataSync/common/userDataSyncAccount';
import { IUserDataAutoSyncEnablementService } from 'vs/platform/userDataSync/common/userDataSync';
import { ILifecycleService, LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IHostService } from 'vs/workbench/services/host/browser/host';
import { IExtensionBisectService } from 'vs/workbench/services/extensionManagement/browser/extensionBisect';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from 'vs/platform/workspace/common/workspaceTrust';
import { Promises } from 'vs/base/common/async';
import { IExtensionManifestPropertiesService } from 'vs/workbench/services/extensions/common/extensionManifestPropertiesService';
import { isVirtualWorkspace } from 'vs/platform/remote/common/remoteHosts';
import { ILogService } from 'vs/platform/log/common/log';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';

const SOURCE = 'IWorkbenchExtensionEnablementService';

export class ExtensionEnablementService extends Disposable implements IWorkbenchExtensionEnablementService {

	declare readonly _serviceBrand: undefined;

	private readonly _onEnablementChanged = new Emitter<readonly IExtension[]>();
	public readonly onEnablementChanged: Event<readonly IExtension[]> = this._onEnablementChanged.event;

	protected readonly extensionsManager: ExtensionsManager;
	private readonly storageManger: StorageManager;

	constructor(
		@IStorageService storageService: IStorageService,
		@IGlobalExtensionEnablementService protected readonly globalExtensionEnablementService: IGlobalExtensionEnablementService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IExtensionManagementService extensionManagementService: IExtensionManagementService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExtensionManagementServerService private readonly extensionManagementServerService: IExtensionManagementServerService,
		@IUserDataAutoSyncEnablementService private readonly userDataAutoSyncEnablementService: IUserDataAutoSyncEnablementService,
		@IUserDataSyncAccountService private readonly userDataSyncAccountService: IUserDataSyncAccountService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService readonly hostService: IHostService,
		@IExtensionBisectService private readonly extensionBisectService: IExtensionBisectService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IWorkspaceTrustRequestService private readonly workspaceTrustRequestService: IWorkspaceTrustRequestService,
		@IExtensionManifestPropertiesService private readonly extensionManifestPropertiesService: IExtensionManifestPropertiesService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.storageManger = this._register(new StorageManager(storageService));

		const uninstallDisposable = this._register(Event.filter(extensionManagementService.onDidUninstallExtension, e => !e.error)(({ identifier }) => this._reset(identifier)));
		let isDisposed = false;
		this._register(toDisposable(() => isDisposed = true));
		this.extensionsManager = this._register(instantiationService.createInstance(ExtensionsManager));
		this.extensionsManager.whenInitialized().then(() => {
			if (!isDisposed) {
				this._register(this.extensionsManager.onDidChangeExtensions(({ added, removed }) => this._onDidChangeExtensions(added, removed)));
				uninstallDisposable.dispose();
			}
		});

		this._register(this.globalExtensionEnablementService.onDidChangeEnablement(({ extensions, source }) => this._onDidChangeGloballyDisabledExtensions(extensions, source)));

		// delay notification for extensions disabled until workbench restored
		if (this.allUserExtensionsDisabled) {
			this.lifecycleService.when(LifecyclePhase.Eventually).then(() => {
				this.notificationService.prompt(Severity.Info, localize('extensionsDisabled', "All installed extensions are temporarily disabled."), [{
					label: localize('Reload', "Reload and Enable Extensions"),
					run: () => hostService.reload({ disableExtensions: false })
				}]);
			});
		}
	}

	private get hasWorkspace(): boolean {
		return this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY;
	}

	private get allUserExtensionsDisabled(): boolean {
		return this.environmentService.disableExtensions === true;
	}

	getEnablementState(extension: IExtension): EnablementState {
		return this._computeEnablementState(extension, this.extensionsManager.extensions);
	}

	getEnablementStates(extensions: IExtension[]): EnablementState[] {
		const extensionsEnablements = new Map<IExtension, EnablementState>();
		return extensions.map(extension => this._computeEnablementState(extension, extensions, extensionsEnablements));
	}

	canChangeEnablement(extension: IExtension): boolean {
		try {
			this.throwErrorIfCannotChangeEnablement(extension);
		} catch (error) {
			return false;
		}
		const enablementState = this.getEnablementState(extension);
		if (enablementState === EnablementState.DisabledByEnvironment
			|| enablementState === EnablementState.DisabledByVirtualWorkspace
			|| enablementState === EnablementState.DisabledByExtensionDependency
			|| enablementState === EnablementState.DisabledByExtensionKind) {
			return false;
		}
		return true;
	}

	canChangeWorkspaceEnablement(extension: IExtension): boolean {
		if (!this.canChangeEnablement(extension)) {
			return false;
		}
		try {
			this.throwErrorIfCannotChangeWorkspaceEnablement(extension);
		} catch (error) {
			return false;
		}
		return true;
	}

	private throwErrorIfCannotChangeEnablement(extension: IExtension): void {
		if (isLanguagePackExtension(extension.manifest)) {
			throw new Error(localize('cannot disable language pack extension', "Cannot change enablement of {0} extension because it contributes language packs.", extension.manifest.displayName || extension.identifier.id));
		}

		if (this.userDataAutoSyncEnablementService.isEnabled() && this.userDataSyncAccountService.account &&
			isAuthenticaionProviderExtension(extension.manifest) && extension.manifest.contributes!.authentication!.some(a => a.id === this.userDataSyncAccountService.account!.authenticationProviderId)) {
			throw new Error(localize('cannot disable auth extension', "Cannot change enablement {0} extension because Settings Sync depends on it.", extension.manifest.displayName || extension.identifier.id));
		}
	}

	private throwErrorIfCannotChangeWorkspaceEnablement(extension: IExtension): void {
		if (!this.hasWorkspace) {
			throw new Error(localize('noWorkspace', "No workspace."));
		}
		if (isAuthenticaionProviderExtension(extension.manifest)) {
			throw new Error(localize('cannot disable auth extension in workspace', "Cannot change enablement of {0} extension in workspace because it contributes authentication providers", extension.manifest.displayName || extension.identifier.id));
		}
	}

	async setEnablement(extensions: IExtension[], newState: EnablementState): Promise<boolean[]> {

		const workspace = newState === EnablementState.DisabledWorkspace || newState === EnablementState.EnabledWorkspace;
		for (const extension of extensions) {
			if (workspace) {
				this.throwErrorIfCannotChangeWorkspaceEnablement(extension);
			} else {
				this.throwErrorIfCannotChangeEnablement(extension);
			}
		}

		const result = await Promises.settled(extensions.map(async e => {
			if (this.getEnablementState(e) === EnablementState.DisabledByTrustRequirement) {
				const trustState = await this.workspaceTrustRequestService.requestWorkspaceTrust();
				return trustState ?? false;
			} else {
				return this._setUserEnablementState(e, newState);
			}
		}));

		const changedExtensions = extensions.filter((e, index) => result[index]);
		if (changedExtensions.length) {
			this._onEnablementChanged.fire(changedExtensions);
		}
		return result;
	}

	private _setUserEnablementState(extension: IExtension, newState: EnablementState): Promise<boolean> {

		const currentState = this._getUserEnablementState(extension.identifier);

		if (currentState === newState) {
			return Promise.resolve(false);
		}

		switch (newState) {
			case EnablementState.EnabledGlobally:
				this._enableExtension(extension.identifier);
				break;
			case EnablementState.DisabledGlobally:
				this._disableExtension(extension.identifier);
				break;
			case EnablementState.EnabledWorkspace:
				this._enableExtensionInWorkspace(extension.identifier);
				break;
			case EnablementState.DisabledWorkspace:
				this._disableExtensionInWorkspace(extension.identifier);
				break;
		}

		return Promise.resolve(true);
	}

	isEnabled(extension: IExtension): boolean {
		const enablementState = this.getEnablementState(extension);
		return this._isEnabledEnablementState(enablementState);
	}

	private _isEnabledEnablementState(enablementState: EnablementState): boolean {
		return enablementState === EnablementState.EnabledWorkspace || enablementState === EnablementState.EnabledGlobally;
	}

	isDisabledGlobally(extension: IExtension): boolean {
		return this._isDisabledGlobally(extension.identifier);
	}

	private _computeEnablementState(extension: IExtension, extensions: ReadonlyArray<IExtension>, computedEnablementStates?: Map<IExtension, EnablementState>): EnablementState {
		computedEnablementStates = computedEnablementStates ?? new Map<IExtension, EnablementState>();
		let enablementState = computedEnablementStates.get(extension);
		if (enablementState !== undefined) {
			return enablementState;
		}

		if (this.extensionBisectService.isDisabledByBisect(extension)) {
			enablementState = EnablementState.DisabledByEnvironment;
		}

		else if (this._isDisabledInEnv(extension)) {
			enablementState = EnablementState.DisabledByEnvironment;
		}

		else if (this._isDisabledByVirtualWorkspace(extension)) {
			enablementState = EnablementState.DisabledByVirtualWorkspace;
		}

		else if (this._isDisabledByExtensionKind(extension)) {
			enablementState = EnablementState.DisabledByExtensionKind;
		}

		else {
			enablementState = this._getUserEnablementState(extension.identifier);
			if (this._isEnabledEnablementState(enablementState)) {
				if (this._isDisabledByWorkspaceTrust(extension, extensions)) {
					enablementState = EnablementState.DisabledByTrustRequirement;
				}

				else if (this._isDisabledByExtensionDependency(extension, extensions, computedEnablementStates)) {
					enablementState = EnablementState.DisabledByExtensionDependency;
				}
			}
		}

		computedEnablementStates.set(extension, enablementState);
		return enablementState;
	}

	private _isDisabledInEnv(extension: IExtension): boolean {
		if (this.allUserExtensionsDisabled) {
			return !extension.isBuiltin;
		}

		const disabledExtensions = this.environmentService.disableExtensions;
		if (Array.isArray(disabledExtensions)) {
			return disabledExtensions.some(id => areSameExtensions({ id }, extension.identifier));
		}

		// Check if this is the better merge extension which was migrated to a built-in extension
		if (areSameExtensions({ id: BetterMergeId.value }, extension.identifier)) {
			return true;
		}

		return false;
	}

	private _isDisabledByVirtualWorkspace(extension: IExtension): boolean {
		if (isVirtualWorkspace(this.contextService.getWorkspace())) {
			return this.extensionManifestPropertiesService.getExtensionVirtualWorkspaceSupportType(extension.manifest) === false;
		}
		return false;
	}

	private _isDisabledByExtensionKind(extension: IExtension): boolean {
		if (this.extensionManagementServerService.remoteExtensionManagementServer || this.extensionManagementServerService.webExtensionManagementServer) {
			const server = this.extensionManagementServerService.getExtensionManagementServer(extension);
			for (const extensionKind of this.extensionManifestPropertiesService.getExtensionKind(extension.manifest)) {
				if (extensionKind === 'ui') {
					if (this.extensionManagementServerService.localExtensionManagementServer && this.extensionManagementServerService.localExtensionManagementServer === server) {
						return false;
					}
				}
				if (extensionKind === 'workspace') {
					if (server === this.extensionManagementServerService.remoteExtensionManagementServer) {
						return false;
					}
				}
				if (extensionKind === 'web') {
					if (this.extensionManagementServerService.webExtensionManagementServer) {
						if (server === this.extensionManagementServerService.webExtensionManagementServer) {
							return false;
						}
					} else if (server === this.extensionManagementServerService.localExtensionManagementServer) {
						const enableLocalWebWorker = this.configurationService.getValue<boolean>(webWorkerExtHostConfig);
						if (enableLocalWebWorker) {
							// Web extensions are enabled on all configurations
							return false;
						}
					}
				}
			}
			return true;
		}
		return false;
	}

	private _isDisabledByWorkspaceTrust(extension: IExtension, extensions: ReadonlyArray<IExtension>): boolean {
		if (this.workspaceTrustManagementService.isWorkpaceTrusted()) {
			return false;
		}

		// Find dependencies from the same server as of the extension
		const installedExtensions = extensions.filter(e => this.extensionManagementServerService.getExtensionManagementServer(e) === this.extensionManagementServerService.getExtensionManagementServer(extension));
		return [extension, ...getExtensionDependencies(installedExtensions, extension)].some(extension => this.extensionManifestPropertiesService.getExtensionUntrustedWorkspaceSupportType(extension.manifest) === false);
	}

	private _isDisabledByExtensionDependency(extension: IExtension, extensions: ReadonlyArray<IExtension>, computedEnablementStates: Map<IExtension, EnablementState>): boolean {
		// Find dependencies from the same server as of the extension
		const dependencyExtensions = extension.manifest.extensionDependencies
			? extensions.filter(e =>
				extension.manifest.extensionDependencies!.some(id => areSameExtensions(e.identifier, { id }) && this.extensionManagementServerService.getExtensionManagementServer(e) === this.extensionManagementServerService.getExtensionManagementServer(extension)))
			: [];

		if (!dependencyExtensions.length) {
			return false;
		}

		const hasEnablementState = computedEnablementStates.has(extension);
		if (!hasEnablementState) {
			// Placeholder to handle cyclic deps
			computedEnablementStates.set(extension, EnablementState.EnabledGlobally);
		}
		try {
			for (const dependencyExtension of dependencyExtensions) {
				if (!this._isEnabledEnablementState(this._computeEnablementState(dependencyExtension, extensions, computedEnablementStates))) {
					return true;
				}
			}
		} finally {
			if (!hasEnablementState) {
				// remove the placeholder
				computedEnablementStates.delete(extension);
			}
		}

		return false;
	}

	private _getUserEnablementState(identifier: IExtensionIdentifier): EnablementState {
		if (this.hasWorkspace) {
			if (this._getWorkspaceEnabledExtensions().filter(e => areSameExtensions(e, identifier))[0]) {
				return EnablementState.EnabledWorkspace;
			}

			if (this._getWorkspaceDisabledExtensions().filter(e => areSameExtensions(e, identifier))[0]) {
				return EnablementState.DisabledWorkspace;
			}
		}
		if (this._isDisabledGlobally(identifier)) {
			return EnablementState.DisabledGlobally;
		}
		return EnablementState.EnabledGlobally;
	}

	private _isDisabledGlobally(identifier: IExtensionIdentifier): boolean {
		return this.globalExtensionEnablementService.getDisabledExtensions().some(e => areSameExtensions(e, identifier));
	}

	private _enableExtension(identifier: IExtensionIdentifier): Promise<boolean> {
		this._removeFromWorkspaceDisabledExtensions(identifier);
		this._removeFromWorkspaceEnabledExtensions(identifier);
		return this.globalExtensionEnablementService.enableExtension(identifier, SOURCE);
	}

	private _disableExtension(identifier: IExtensionIdentifier): Promise<boolean> {
		this._removeFromWorkspaceDisabledExtensions(identifier);
		this._removeFromWorkspaceEnabledExtensions(identifier);
		return this.globalExtensionEnablementService.disableExtension(identifier, SOURCE);
	}

	private _enableExtensionInWorkspace(identifier: IExtensionIdentifier): void {
		this._removeFromWorkspaceDisabledExtensions(identifier);
		this._addToWorkspaceEnabledExtensions(identifier);
	}

	private _disableExtensionInWorkspace(identifier: IExtensionIdentifier): void {
		this._addToWorkspaceDisabledExtensions(identifier);
		this._removeFromWorkspaceEnabledExtensions(identifier);
	}

	private _addToWorkspaceDisabledExtensions(identifier: IExtensionIdentifier): Promise<boolean> {
		if (!this.hasWorkspace) {
			return Promise.resolve(false);
		}
		let disabledExtensions = this._getWorkspaceDisabledExtensions();
		if (disabledExtensions.every(e => !areSameExtensions(e, identifier))) {
			disabledExtensions.push(identifier);
			this._setDisabledExtensions(disabledExtensions);
			return Promise.resolve(true);
		}
		return Promise.resolve(false);
	}

	private async _removeFromWorkspaceDisabledExtensions(identifier: IExtensionIdentifier): Promise<boolean> {
		if (!this.hasWorkspace) {
			return false;
		}
		let disabledExtensions = this._getWorkspaceDisabledExtensions();
		for (let index = 0; index < disabledExtensions.length; index++) {
			const disabledExtension = disabledExtensions[index];
			if (areSameExtensions(disabledExtension, identifier)) {
				disabledExtensions.splice(index, 1);
				this._setDisabledExtensions(disabledExtensions);
				return true;
			}
		}
		return false;
	}

	private _addToWorkspaceEnabledExtensions(identifier: IExtensionIdentifier): boolean {
		if (!this.hasWorkspace) {
			return false;
		}
		let enabledExtensions = this._getWorkspaceEnabledExtensions();
		if (enabledExtensions.every(e => !areSameExtensions(e, identifier))) {
			enabledExtensions.push(identifier);
			this._setEnabledExtensions(enabledExtensions);
			return true;
		}
		return false;
	}

	private _removeFromWorkspaceEnabledExtensions(identifier: IExtensionIdentifier): boolean {
		if (!this.hasWorkspace) {
			return false;
		}
		let enabledExtensions = this._getWorkspaceEnabledExtensions();
		for (let index = 0; index < enabledExtensions.length; index++) {
			const disabledExtension = enabledExtensions[index];
			if (areSameExtensions(disabledExtension, identifier)) {
				enabledExtensions.splice(index, 1);
				this._setEnabledExtensions(enabledExtensions);
				return true;
			}
		}
		return false;
	}

	protected _getWorkspaceEnabledExtensions(): IExtensionIdentifier[] {
		return this._getExtensions(ENABLED_EXTENSIONS_STORAGE_PATH);
	}

	private _setEnabledExtensions(enabledExtensions: IExtensionIdentifier[]): void {
		this._setExtensions(ENABLED_EXTENSIONS_STORAGE_PATH, enabledExtensions);
	}

	protected _getWorkspaceDisabledExtensions(): IExtensionIdentifier[] {
		return this._getExtensions(DISABLED_EXTENSIONS_STORAGE_PATH);
	}

	private _setDisabledExtensions(disabledExtensions: IExtensionIdentifier[]): void {
		this._setExtensions(DISABLED_EXTENSIONS_STORAGE_PATH, disabledExtensions);
	}

	private _getExtensions(storageId: string): IExtensionIdentifier[] {
		if (!this.hasWorkspace) {
			return [];
		}
		return this.storageManger.get(storageId, StorageScope.WORKSPACE);
	}

	private _setExtensions(storageId: string, extensions: IExtensionIdentifier[]): void {
		this.storageManger.set(storageId, extensions, StorageScope.WORKSPACE);
	}

	private async _onDidChangeGloballyDisabledExtensions(extensionIdentifiers: ReadonlyArray<IExtensionIdentifier>, source?: string): Promise<void> {
		if (source !== SOURCE) {
			await this.extensionsManager.whenInitialized();
			const extensions = this.extensionsManager.extensions.filter(installedExtension => extensionIdentifiers.some(identifier => areSameExtensions(identifier, installedExtension.identifier)));
			this._onEnablementChanged.fire(extensions);
		}
	}

	private _onDidChangeExtensions(added: ReadonlyArray<IExtension>, removed: ReadonlyArray<IExtension>): void {
		const disabledByTrustExtensions = added.filter(e => this.getEnablementState(e) === EnablementState.DisabledByTrustRequirement);
		if (disabledByTrustExtensions.length) {
			this._onEnablementChanged.fire(disabledByTrustExtensions);
		}
		removed.forEach(({ identifier }) => this._reset(identifier));
	}

	public async updateEnablementByWorkspaceTrustRequirement(): Promise<void> {
		await this.extensionsManager.whenInitialized();

		const disabledExtensions = this.extensionsManager.extensions
			.filter(extension => {
				const dependencies = getExtensionDependencies(this.extensionsManager.extensions, extension);
				const isEnabled = this._isEnabledEnablementState(this._getUserEnablementState(extension.identifier));

				return isEnabled && (this.extensionManifestPropertiesService.getExtensionUntrustedWorkspaceSupportType(extension.manifest) === false ||
					dependencies.some(ext => this.extensionManifestPropertiesService.getExtensionUntrustedWorkspaceSupportType(ext.manifest) === false));
			});

		if (disabledExtensions.length) {
			this._onEnablementChanged.fire(disabledExtensions);
		}
	}

	private _reset(extension: IExtensionIdentifier) {
		this._removeFromWorkspaceDisabledExtensions(extension);
		this._removeFromWorkspaceEnabledExtensions(extension);
		this.globalExtensionEnablementService.enableExtension(extension);
	}
}

class ExtensionsManager extends Disposable {

	private _extensions: IExtension[] = [];
	get extensions(): readonly IExtension[] { return this._extensions; }

	private _onDidChangeExtensions = this._register(new Emitter<{ added: readonly IExtension[], removed: readonly IExtension[] }>());
	readonly onDidChangeExtensions = this._onDidChangeExtensions.event;

	private readonly initializePromise;

	constructor(
		@IWorkbenchExtensionManagementService private readonly extensionManagementService: IWorkbenchExtensionManagementService,
		@IExtensionManagementServerService private readonly extensionManagementServerService: IExtensionManagementServerService,
		@ILogService private readonly logService: ILogService
	) {
		super();
		this.initializePromise = this.initialize();
	}

	whenInitialized(): Promise<void> {
		return this.initializePromise;
	}

	private async initialize(): Promise<void> {
		try {
			this._extensions = await this.extensionManagementService.getInstalled();
			this._onDidChangeExtensions.fire({ added: this.extensions, removed: [] });
		} catch (error) {
			this.logService.error(error);
		}
		Event.filter(this.extensionManagementService.onDidInstallExtension, (e => !!e.local))(e => this.onDidInstallExtension(e.local!));
		Event.filter(this.extensionManagementService.onDidUninstallExtension, (e => !e.error))(e => this.onDidUninstallExtension(e.identifier, e.server));
	}

	private onDidInstallExtension(extension: IExtension): void {
		this._extensions.push(extension);
		this._onDidChangeExtensions.fire({ added: [extension], removed: [] });
	}

	private onDidUninstallExtension(identifier: IExtensionIdentifier, server: IExtensionManagementServer): void {
		const index = this._extensions.findIndex(e => areSameExtensions(e.identifier, identifier) && this.extensionManagementServerService.getExtensionManagementServer(e) === server);
		if (index !== -1) {
			const removed = this._extensions.splice(index, 1);
			this._onDidChangeExtensions.fire({ added: [], removed });
		}
	}
}

registerSingleton(IWorkbenchExtensionEnablementService, ExtensionEnablementService);
