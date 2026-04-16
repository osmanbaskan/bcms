export type SignalStatus = 'OK' | 'DEGRADED' | 'LOST';

export interface SignalTelemetry {
  id:         number;
  channelId:  number;
  signalDb?:  number;
  snr?:       number;
  ber?:       number;
  audioLufs?: number;
  status:     SignalStatus;
  source?:    string;
  measuredAt: string;
}

export interface ChannelSignalSummary {
  channelId:   number;
  channelName: string;
  channelType: string;
  telemetry:   SignalTelemetry | null;
}

export interface SubmitSignalDto {
  channelId: number;
  signalDb?:  number;
  snr?:       number;
  ber?:       number;
  audioLufs?: number;
  status:     SignalStatus;
  source?:    string;
}
