import { EventEmitter } from "@hediet/std/events";
import { Disposable } from "@hediet/std/disposable";
import { DrawioConfig, DrawioEvent, DrawioAction } from "./DrawioTypes";

export class DrawioInstance<
	TCustomAction extends {} = never,
	TCustomEvent extends {} = never
> {
	public readonly dispose = Disposable.fn();

	private readonly onInitEmitter = new EventEmitter();
	public readonly onInit = this.onInitEmitter.asEvent();

	private readonly onChangeEmitter = new EventEmitter<DrawioDocumentChange>();
	public readonly onChange = this.onChangeEmitter.asEvent();

	private readonly onSaveEmitter = new EventEmitter();
	public readonly onSave = this.onSaveEmitter.asEvent();

	private readonly onUnknownMessageEmitter = new EventEmitter<{
		message: TCustomEvent;
	}>();
	public readonly onUnknownMessage = this.onUnknownMessageEmitter.asEvent();

	// This is always up to date, except directly after calling load.
	private currentXml: string | undefined = undefined;

	constructor(
		private readonly messageStream: MessageStream,
		private readonly getConfig: () => Promise<DrawioConfig>
	) {
		this.dispose.track(
			messageStream.registerMessageHandler((msg) =>
				this.handleEvent(JSON.parse(msg as string) as DrawioEvent)
			)
		);
	}

	private currentActionId = 0;
	private responseHandlers = new Map<
		string,
		{ resolve: (response: DrawioEvent) => void; reject: () => void }
	>();

	protected sendCustomAction(action: TCustomAction): void {
		this.sendAction(action);
	}

	protected sendCustomActionExpectResponse(
		action: TCustomAction
	): Promise<TCustomEvent> {
		return this.sendActionWaitForResponse(action);
	}

	private sendAction(action: DrawioAction | TCustomAction) {
		this.messageStream.sendMessage(JSON.stringify(action));
	}

	private sendActionWaitForResponse(
		action: DrawioAction
	): Promise<DrawioEvent>;
	private sendActionWaitForResponse(
		action: TCustomAction
	): Promise<TCustomEvent>;
	private sendActionWaitForResponse(
		action: DrawioAction | TCustomAction
	): Promise<DrawioEvent | TCustomEvent> {
		return new Promise((resolve, reject) => {
			const actionId = (this.currentActionId++).toString();

			this.responseHandlers.set(actionId, {
				resolve: (response) => {
					this.responseHandlers.delete(actionId);
					resolve(response);
				},
				reject,
			});

			this.messageStream.sendMessage(
				JSON.stringify(Object.assign(action, { actionId }))
			);
		});
	}

	protected async handleEvent(evt: { event: string }): Promise<void> {
		const drawioEvt = evt as DrawioEvent;

		if ("message" in drawioEvt) {
			const actionId = (drawioEvt.message as any).actionId as
				| string
				| undefined;
			if (actionId) {
				const responseHandler = this.responseHandlers.get(actionId);
				this.responseHandlers.delete(actionId);
				if (responseHandler) {
					responseHandler.resolve(drawioEvt);
				}
			}
		} else if (drawioEvt.event === "init") {
			this.onInitEmitter.emit();
		} else if (drawioEvt.event === "autosave") {
			const newXml = drawioEvt.xml;
			const oldXml = this.currentXml;
			this.currentXml = newXml;

			this.onChangeEmitter.emit({ newXml, oldXml });
		} else if (drawioEvt.event === "save") {
			this.onSaveEmitter.emit();
		} else if (drawioEvt.event === "export") {
			// sometimes, message is not included :(
			// this is a hack to find the request to resolve
			const vals = [...this.responseHandlers.values()];
			this.responseHandlers.clear();
			if (vals.length !== 1) {
				for (const val of vals) {
					val.reject();
				}
			} else {
				vals[0].resolve(drawioEvt);
			}
		} else if (drawioEvt.event === "configure") {
			const config = await this.getConfig();
			this.sendAction({
				action: "configure",
				config,
			});
		} else {
			this.onUnknownMessageEmitter.emit({ message: drawioEvt });
		}
	}

	public async mergeXmlLike(xmlLike: string): Promise<void> {
		const evt = await this.sendActionWaitForResponse({
			action: "merge",
			xml: xmlLike,
		});

		if (evt.event !== "merge") {
			throw new Error("Invalid response");
		}
		if (evt.error) {
			throw new Error(evt.error);
		}
	}

	/**
	 * This loads an xml or svg+xml Draw.io diagram.
	 */
	public loadXmlLike(xmlLike: string) {
		if (xmlLike === "") {
			// see https://github.com/jgraph/drawio/issues/915
			xmlLike = `
<mxfile host="localhost" modified="2020-05-14T13:54:05.771Z" agent="5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.45.0 Chrome/78.0.3904.130 Electron/7.2.4 Safari/537.36" etag="eoEzpxJQLkNMd8Iw5vpY" version="13.0.9">
	<diagram id="6hGFLwfOUW9BJ-s0fimq" name="Page-1">
		<mxGraphModel dx="606" dy="468" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">
			<root>
				<mxCell id="0"/>
				<mxCell id="1" parent="0"/>
			</root>
		</mxGraphModel>
	</diagram>
</mxfile>`;
		}

		this.currentXml = undefined;
		this.sendAction({
			action: "load",
			xml: xmlLike,
			autosave: 1,
		});
	}

	public async loadPngWithEmbeddedXml(png: Uint8Array): Promise<void> {
		let str = Buffer.from(png).toString("base64");
		this.loadXmlLike("data:image/png;base64," + str);
	}

	public async export(extension: string): Promise<Buffer> {
		if (extension.endsWith(".png")) {
			return await this.exportAsPngWithEmbeddedXml();
		} else if (
			extension.endsWith(".drawio") ||
			extension.endsWith(".dio")
		) {
			const xml = await this.getXml();
			return Buffer.from(xml, "utf-8");
		} else if (extension.endsWith(".svg")) {
			return await this.exportAsSvgWithEmbeddedXml();
		} else {
			throw new Error(
				`Invalid file extension "${extension}"! Only ".png", ".svg" and ".drawio" are supported.`
			);
		}
	}

	public async getXml(): Promise<string> {
		if (!this.currentXml) {
			const response = await this.sendActionWaitForResponse({
				action: "export",
				format: "xml",
			});
			if (response.event !== "export") {
				throw new Error("Unexpected response");
			}

			if (!this.currentXml) {
				// It might have been changed in the meantime.
				// Always trust autosave.
				this.currentXml = response.xml;
			}
		}
		return this.currentXml;
	}

	public async exportAsPngWithEmbeddedXml(): Promise<Buffer> {
		const response = await this.sendActionWaitForResponse({
			action: "export",
			format: "xmlpng",
		});
		if (response.event !== "export") {
			throw new Error("Unexpected response");
		}
		const start = "data:image/png;base64,";
		if (!response.data.startsWith(start)) {
			throw new Error("Invalid data");
		}
		const base64Data = response.data.substr(start.length);
		return Buffer.from(base64Data, "base64");
	}

	public async exportAsSvgWithEmbeddedXml(): Promise<Buffer> {
		const response = await this.sendActionWaitForResponse({
			action: "export",
			format: "xmlsvg",
		});
		if (response.event !== "export") {
			throw new Error("Unexpected response");
		}
		const start = "data:image/svg+xml;base64,";
		if (!response.data.startsWith(start)) {
			throw new Error("Invalid data");
		}
		const base64Data = response.data.substr(start.length);
		return Buffer.from(base64Data, "base64");
	}
}

export interface DrawioDocumentChange {
	oldXml: string | undefined;
	newXml: string;
}

export interface MessageStream {
	registerMessageHandler(handler: (message: unknown) => void): Disposable;
	sendMessage(message: unknown): void;
}
