export interface GoLiveDto {
  tcIn?: string;
  note?: string;
}

export interface EndPlayoutDto {
  tcOut?: string;
  note?:  string;
}

export interface CreateTimelineEventDto {
  tc?:   string;
  type?: string;
  note?: string;
}
