import { Component } from "engine/shared/component/Component";
import { BlocksSerializer } from "shared/building/BlocksSerializer";
import { SlotsMeta } from "shared/SlotsMeta";
import { JSON } from "engine/shared/fixes/Json";
import type { PlayerDatabase } from "server/database/PlayerDatabase";
import type { SlotDatabase } from "server/database/SlotDatabase";
import type { PlayerId } from "server/PlayerId";
import type { BuildingPlot } from "shared/building/BuildingPlot";
import type { PlayerDataStorageRemotesSlots } from "shared/remotes/PlayerDataRemotes";
import { Base64 } from "@rbxts/crypto";
import { Zlib } from "@rbxts/zlib";

export interface SlotHistoryLoader {
	readonly loadSlotHistory: (
		selv: ServerSlotRequestController,
		{ index }: PlayerLoadSlotRequest,
	) => LoadSlotHistoryResponse;
	readonly loadSlotFromHistory: (
		selv: ServerSlotRequestController,
		{ databaseId, historyId }: PlayerLoadSlotFromHistoryRequest,
	) => LoadSlotResponse;
}

@injectable
export class ServerSlotRequestController extends Component {
	constructor(
		@inject readonly playerId: PlayerId,
		@inject slotRemotes: PlayerDataStorageRemotesSlots,
		@inject readonly blocks: BuildingPlot,

		@inject readonly blockList: BlockList,
		@inject readonly players: PlayerDatabase,
		@inject readonly slots: SlotDatabase,
	) {
		super();

		this.onInject(() => {
			const loader: SlotHistoryLoader = this.getDI().tryResolve<SlotHistoryLoader>() ?? {
				loadSlotHistory: () => ({ success: false, message: "Unavailable" }),
				loadSlotFromHistory: () => ({ success: false, message: "Unavailable" }),
			};

			slotRemotes.loadHistory.subscribe((p, arg) => loader.loadSlotHistory(this, arg));
			slotRemotes.loadFromHistory.subscribe((p, arg) => loader.loadSlotFromHistory(this, arg));
		});

		slotRemotes.load.subscribe((p, arg) => this.loadSlot(arg));
		slotRemotes.save.subscribe((p, arg) => this.saveSlot(arg));
		slotRemotes.delete.subscribe((p, arg) => this.deleteSlot(arg));
		slotRemotes.loadFromShareCode.subscribe((p, arg) => this.loadFromShareCode(arg));
		slotRemotes.getShareCode.subscribe((p, arg) => this.getShareCode(arg));
	}

	private saveSlot(request: PlayerSaveSlotRequest): SaveSlotResponse {
		if (SlotsMeta.isReadonly(request.index)) {
			throw `Slot is readonly while saving ${this.playerId} ${request.index}`;
		}

		$log(`Saving ${this.playerId}'s slot ${request.index}`);

		let output: ResponseResult<SaveSlotResponse> | undefined;
		const currentMeta = this.players.get(this.playerId).slots ?? [];
		if (!request.save && !currentMeta.any((c) => c.index === request.index)) {
			// new slot creation

			this.slots.setBlocks(this.playerId, request.index, undefined);
			output = { blocks: 0 };
		} else if (request.save) {
			const blocks = BlocksSerializer.serializeToObject(this.blocks);
			this.slots.setBlocks(this.playerId, request.index, blocks);
			output = { blocks: blocks.blocks.size() };
		}

		this.slots.updateMeta(this.playerId, request.index, (meta) => {
			const get = SlotsMeta.get(meta, request.index);
			return SlotsMeta.withSlot(meta, request.index, {
				name: request.name ?? get.name,
				color: request.color ?? get.color,
				touchControls: request.touchControls ?? get.touchControls,
				order: request.order ?? get.order,
			});
		});

		return {
			success: true,
			blocks: output?.blocks,
		};
	}
	private deleteSlot(request: PlayerDeleteSlotRequest): Response {
		if (SlotsMeta.isReadonly(request.index) && !SlotsMeta.isTestSlot(request.index)) {
			throw `Slot is readonly while deleting ${this.playerId} ${request.index}`;
		}

		$log(`Deleting ${this.playerId}'s slot ${request.index}`);
		this.slots.delete(this.playerId, request.index);

		return { success: true };
	}

	private loadSlot({ index }: PlayerLoadSlotRequest): LoadSlotResponse {
		return this.forceLoadSlot(this.playerId, index);
	}
	private forceLoadSlot(userid: number, index: number): LoadSlotResponse {
		const start = os.clock();
		const blocks = this.slots.getBlocks(userid, index);

		this.blocks.deleteOperation.execute("all");
		if (blocks.blocks.size() === 0) {
			return { success: true, isEmpty: true };
		}

		$log(`Loading ${userid}'s slot ${index}`);
		const dblocks = BlocksSerializer.deserializeFromObject(blocks, this.blocks, this.blockList);
		$log(`Loaded ${userid} slot ${index} in ${os.clock() - start}`);

		return { success: true, isEmpty: dblocks === 0 };
	}
	private getShareCode(slot: SlotMeta): GetShareCodeResponse {
		const blocks = this.slots.getBlocks(this.playerId, slot.index);
		const json = BlocksSerializer.objectToJson(blocks);
		const raw = JSON.serialize(json);

		const compressed = Zlib.Compress(raw);
		const shareCode = Base64.Encode(compressed);

		return { success: true, shareCode: shareCode };
	}
	private loadFromShareCode(code: string): LoadSlotResponse {
		if (!code || code.size() === 0) {
			return { success: false, message: "Invalid share code" };
		}

		this.blocks.deleteOperation.execute("all");

		$log(`Deserializing share code`);
		const compressed = Base64.Decode(code);
		const raw = Zlib.Decompress(compressed);
		const json = JSON.deserialize(raw) as BlocksSerializer.JsonSerializedBlocks;
		const obj = BlocksSerializer.jsonToObject(json);

		$log("Loading slot from share code");
		const dblocks = BlocksSerializer.deserializeFromObject(obj, this.blocks, this.blockList);
		$log("Loaded slot from share code");

		return { success: true, isEmpty: dblocks === 0 };
	}
}
