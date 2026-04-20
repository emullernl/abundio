import type * as ReactNS from "react";

export const PLUGIN_API_MODULE = "abundio:plugin-api";

export type PluginCommandArgs = Record<string, string>;

export interface HostPluginApi {
	invoke: (commandId: string, args?: PluginCommandArgs) => Promise<string>;
	getInfo: () => {
		pluginId: string;
	};
}

export interface RuntimePluginApi {
	react: typeof ReactNS;
	plugin: HostPluginApi;
}