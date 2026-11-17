/** A release candidate coming from any ingestion source. */
export interface IndexItem {
  title: string;
  infohash?: string;
  magnet?: string;
  torrentUrl?: string;
  size?: number;
  seeders?: number;
}
