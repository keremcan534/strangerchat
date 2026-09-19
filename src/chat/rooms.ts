/** One-to-one human conversations. */
import { randomUUID } from 'node:crypto';
import type { MatchTier, SessionId } from '../types.js';

export interface Room {
  id: string;
  a: SessionId;
  b: SessionId;
  tier: MatchTier;
  translationRequired: boolean;
  commonInterests: string[];
  createdAt: number;
  messageCount: number;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly bySession = new Map<SessionId, string>();

  create(input: {
    a: SessionId;
    b: SessionId;
    tier: MatchTier;
    translationRequired: boolean;
    commonInterests: string[];
  }): Room {
    const room: Room = {
      id: `room_${randomUUID()}`,
      a: input.a,
      b: input.b,
      tier: input.tier,
      translationRequired: input.translationRequired,
      commonInterests: input.commonInterests,
      createdAt: Date.now(),
      messageCount: 0,
    };
    this.rooms.set(room.id, room);
    this.bySession.set(input.a, room.id);
    this.bySession.set(input.b, room.id);
    return room;
  }

  get(roomId: string): Room | null {
    return this.rooms.get(roomId) ?? null;
  }

  forSession(sessionId: SessionId): Room | null {
    const id = this.bySession.get(sessionId);
    return id ? this.rooms.get(id) ?? null : null;
  }

  partnerOf(sessionId: SessionId): SessionId | null {
    const room = this.forSession(sessionId);
    if (!room) return null;
    return room.a === sessionId ? room.b : room.a;
  }

  close(roomId: string): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    this.rooms.delete(roomId);
    this.bySession.delete(room.a);
    this.bySession.delete(room.b);
    return room;
  }

  get size(): number {
    return this.rooms.size;
  }
}
