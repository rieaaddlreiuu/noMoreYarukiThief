import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCommand, interactionSchema, type CommandDependencies, type Interaction } from "../src/lib/discord/handler";
import { declaration, discordId, guildId, applicationId, channelId } from "./fixtures";

afterEach(() => vi.useRealTimers());

function interaction(name: Interaction["data"]["options"][number]["name"], options: Record<string, string | number | boolean> = {}, permissions = "0"): Interaction {
  return { id: "500000000000000001", application_id: applicationId, type: 2, token: "interaction-token", guild_id: guildId, channel_id: channelId,
    member: { user: { id: discordId }, permissions },
    data: { name: "niki", options: [{ name, type: 1, options: Object.entries(options).map(([name, value]) => ({ name, value, type: 3 })) }] } };
}

function dependencies() {
  const mocks = {
    setup: vi.fn(), setNotifyChannel: vi.fn(), requireSetup: vi.fn(), requireMember: vi.fn(), issueOAuth: vi.fn(),
    createDeclaration: vi.fn().mockResolvedValue(declaration()), cancelDeclaration: vi.fn().mockResolvedValue(declaration({ status: "cancelled" })),
    teamStatus: vi.fn().mockResolvedValue({ members: [], declarations: [], pendingNotifications: 0 }),
    assertChannel: vi.fn(), validateRepository: vi.fn().mockResolvedValue({ repository: "owner/repository", branch: "main" }),
  };
  const deps = { store: mocks, discord: mocks, origin: () => "https://niki.example", validateRepository: mocks.validateRepository } as unknown as CommandDependencies;
  return { mocks, deps };
}

describe("command scope and permissions", () => {
  it("denies setup before doing any writes or external calls", async () => {
    const { mocks, deps } = dependencies();
    await expect(handleCommand(interaction("setup", { channel: channelId }), deps)).rejects.toThrow("権限");
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.assertChannel).not.toHaveBeenCalled();
  });
  it("validates the target channel and records only the current guild", async () => {
    const { mocks, deps } = dependencies();
    await handleCommand(interaction("setup", { channel: channelId }, "32"), deps);
    expect(mocks.assertChannel).toHaveBeenCalledWith(guildId, channelId);
    expect(mocks.setup).toHaveBeenCalledWith(guildId, channelId);
  });
  it("adds the channel where the command ran as the caller's personal channel, and clears it with reset", async () => {
    const { mocks, deps } = dependencies();
    await handleCommand(interaction("notify"), deps);
    expect(mocks.requireMember).toHaveBeenCalledWith(guildId, discordId);
    expect(mocks.assertChannel).toHaveBeenCalledWith(guildId, channelId);
    expect(mocks.setNotifyChannel).toHaveBeenCalledWith(guildId, discordId, channelId);
    mocks.assertChannel.mockClear();
    await handleCommand(interaction("notify", { reset: true }), deps);
    expect(mocks.assertChannel).not.toHaveBeenCalled();
    expect(mocks.setNotifyChannel).toHaveBeenLastCalledWith(guildId, discordId, null);
  });
  it("accepts boolean options and the invoking channel in the signed payload", () => {
    expect(interactionSchema.safeParse(interaction("notify", { reset: true })).success).toBe(true);
    expect(interactionSchema.safeParse({ ...interaction("notify"), channel_id: undefined }).success).toBe(false);
  });
  it("issues only a hashed OAuth ticket, bound to the current guild and caller", async () => {
    const { mocks, deps } = dependencies();
    const { message } = await handleCommand(interaction("github"), deps);
    const [hash, guild, user] = mocks.issueOAuth.mock.calls[0];
    expect(hash).toHaveLength(64);
    expect([guild, user]).toEqual([guildId, discordId]);
    expect(message.content).toContain("/api/github/start?ticket=");
    expect(message.content).not.toContain(hash);
  });
  it("requires participation and validates repository before saving a declaration", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2098-12-31T11:00:00Z"));
    const { mocks, deps } = dependencies();
    await handleCommand(interaction("declare", { content: "開発", repository: "owner/repository", deadline: "2099-01-01 22:00" }), deps);
    expect(mocks.requireMember).toHaveBeenCalledWith(guildId, discordId);
    expect(mocks.createDeclaration).toHaveBeenCalledWith(expect.objectContaining({ guildId, discordId, branch: "main", deadline: "2099-01-01T13:00:00.000Z" }));
    mocks.createDeclaration.mockClear();
    mocks.validateRepository.mockRejectedValueOnce(new Error("GitHub failed"));
    await expect(handleCommand(interaction("declare", { content: "開発", repository: "owner/repository", deadline: "2099-01-01 22:00" }), deps)).rejects.toThrow();
    expect(mocks.createDeclaration).not.toHaveBeenCalled();
  });
  it("always scopes cancellation and status to the signed interaction", async () => {
    const { mocks, deps } = dependencies();
    await handleCommand(interaction("cancel"), deps);
    expect(mocks.cancelDeclaration).toHaveBeenCalledWith(guildId, discordId);
    await handleCommand(interaction("status"), deps);
    expect(mocks.teamStatus).toHaveBeenCalledWith(guildId);
  });
  it("saves a natural-language deadline as UTC", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T11:00:00Z"));
    const { mocks, deps } = dependencies();
    await handleCommand(interaction("declare", { content: "開発", repository: "owner/repository", deadline: "明日 9時" }), deps);
    expect(mocks.createDeclaration).toHaveBeenCalledWith(expect.objectContaining({ deadline: "2026-10-02T00:00:00.000Z" }));
  });
});
