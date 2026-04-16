export type ChannelType = 'HD' | 'SD' | 'OTT' | 'RADIO';

export interface Channel {
  id: number;
  name: string;
  type: ChannelType;
  frequency?: string;
  muxInfo?: Record<string, unknown>;
  active: boolean;
  createdAt: string;
}
