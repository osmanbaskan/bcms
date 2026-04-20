export interface BroadcastType {
  id:          number;
  code:        string;
  description: string;
  createdAt:   string;
  updatedAt:   string;
}

export interface CreateBroadcastTypeDto {
  code:        string;
  description: string;
}

export interface UpdateBroadcastTypeDto {
  code?:        string;
  description?: string;
}
