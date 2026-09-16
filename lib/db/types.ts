/**
 * Types for the Supabase schema in backend/schema.sql.
 *
 * Hand-written rather than generated, so it stays readable and has no toolchain attached;
 * when you change schema.sql, change this too.
 *
 * Everything here is a `type`, never an `interface`. supabase-js checks the schema against
 * `Record<string, unknown>`-shaped constraints, and only type aliases get the implicit index
 * signature that check needs — as interfaces the schema resolves to `never` and every query
 * silently loses its types.
 */

export type BoardRow = {
  id: number;
  slug: string;
  name: string;
  short_name: string;
  region: string;
  board_type: string;
  province: string;
  website: string | null;
  agenda_portal: string | null;
  platform: string;
  status: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type SubscriberRow = {
  id: number;
  email: string;
  created_at: string;
};

export type SubscriberBoardRow = {
  subscriber_id: number;
  board_id: number;
  created_at: string;
};

/** One decoded agenda, kept searchable alongside the JSON the site renders. */
export type DocumentRow = {
  id: string;
  board_id: number;
  title: string;
  meeting_date: string;
  url: string | null;
  created_at: string;
};

/** A passage of an agenda with its embedding; the embedding isn't read by the app. */
export type DocumentChunkRow = {
  id: number;
  document_id: string;
  board_id: number;
  chunk_index: number;
  content: string;
  created_at: string;
};

/** A row from match_document_chunks: a passage plus how close it was and where it came from. */
export type ChunkMatch = {
  id: number;
  document_id: string;
  board_id: number;
  chunk_index: number;
  content: string;
  similarity: number;
  title: string;
  meeting_date: string;
  url: string | null;
};

export type DigestLogRow = {
  meeting_id: string;
  board_id: number | null;
  claimed_at: string;
  sent_at: string | null;
  recipients: number | null;
  failures: number | null;
};

export type Database = {
  public: {
    Tables: {
      boards: {
        Row: BoardRow;
        Insert: Omit<BoardRow, "id" | "created_at" | "updated_at"> & Partial<Pick<BoardRow, "updated_at">>;
        Update: Partial<BoardRow>;
        Relationships: [];
      };
      subscribers: {
        Row: SubscriberRow;
        Insert: Pick<SubscriberRow, "email">;
        Update: Partial<SubscriberRow>;
        Relationships: [];
      };
      subscriber_boards: {
        Row: SubscriberBoardRow;
        Insert: Pick<SubscriberBoardRow, "subscriber_id" | "board_id">;
        Update: Partial<SubscriberBoardRow>;
        Relationships: [];
      };
      digest_log: {
        Row: DigestLogRow;
        Insert: Pick<DigestLogRow, "meeting_id"> & Partial<DigestLogRow>;
        Update: Partial<DigestLogRow>;
        Relationships: [];
      };
      documents: {
        Row: DocumentRow;
        Insert: Omit<DocumentRow, "created_at"> & Partial<Pick<DocumentRow, "created_at">>;
        Update: Partial<DocumentRow>;
        Relationships: [];
      };
      document_chunks: {
        Row: DocumentChunkRow;
        Insert: Omit<DocumentChunkRow, "id" | "created_at"> & { embedding?: number[] };
        Update: Partial<DocumentChunkRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      /** Subscribers who follow a board, i.e. those who chose it plus those who follow all. */
      subscribers_for_board: {
        Args: { filter_board_id?: number | null; after_id?: number; page_size?: number };
        Returns: Pick<SubscriberRow, "id" | "email">[];
      };
      /**
       * Passages closest in meaning to a query embedding, optionally within one board.
       *
       * filter_board_id is a number, not a UUID: boards.id is a bigint identity column.
       */
      match_document_chunks: {
        Args: {
          query_embedding: number[];
          match_threshold?: number;
          match_count?: number;
          filter_board_id?: number | null;
        };
        Returns: ChunkMatch[];
      };
    };
  };
};

/** Postgres/PostgREST codes for "that table or column isn't there", i.e. run the migration. */
export const SCHEMA_MISSING = new Set(["42P01", "42703", "PGRST202", "PGRST204", "PGRST205"]);

export function isSchemaMissing(error: { code?: string } | null | undefined): boolean {
  return !!error?.code && SCHEMA_MISSING.has(error.code);
}
