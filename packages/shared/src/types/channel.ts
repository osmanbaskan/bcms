export type ChannelType = 'HD' | 'SD' | 'OTT' | 'RADIO';

export interface Channel {
  id: number;
  name: string;
  type: ChannelType;
  frequency?: string;
  muxInfo?: Record<string, unknown>;
  active: boolean;
  createdAt: string;
  /** MED-SHARED-004 fix (2026-05-05): DB'de @updatedAt var, type'a eklendi. */
  updatedAt?: string;
}
