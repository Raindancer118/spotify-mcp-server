import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { MAX_BULK_IDS, partialFailure, processInChunks } from './paging.js';
import { playlistIdFrom, playlistParam } from './resolve.js';
import { defineTool, toolError } from './tool.js';
import type { SpotifyHandlerExtra } from './types.js';
import {
  handleSpotifyRequest,
  isGatewayError,
  SpotifyApiError,
  spotifyFetch,
} from './utils.js';

// Spotify's limit applies to the base64 payload, not the raw file.
const MAX_COVER_BASE64_BYTES = 256 * 1024;

async function loadCoverImage(source: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(
        `Downloading ${source} failed (${response.status} ${response.statusText})`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(source);
}

const getPlaylist = defineTool({
  name: 'getPlaylist',
  description:
    'Get details of a specific Spotify playlist including tracks count, description and owner',
  schema: {
    playlistId: playlistParam,
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { playlistId: playlistRef } = args;

    try {
      const playlistId = await playlistIdFrom(playlistRef);
      const playlist = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.playlists.getPlaylist(playlistId);
      });

      const owner =
        playlist.owner?.display_name ?? playlist.owner?.id ?? 'Unknown';
      const tracksTotal =
        playlist.tracks?.total ??
        (playlist as { items?: { total?: number } }).items?.total ??
        0;
      const isPublic = playlist.public ? 'Public' : 'Private';
      const isCollaborative = playlist.collaborative ? ' | Collaborative' : '';
      const description = playlist.description
        ? `\n**Description**: ${playlist.description}`
        : '';
      const url = playlist.external_urls?.spotify ?? '';

      return {
        content: [
          {
            type: 'text',
            text:
              `# Playlist: "${playlist.name}"\n\n` +
              `**Owner**: ${owner}\n` +
              `**Tracks**: ${tracksTotal}\n` +
              `**Visibility**: ${isPublic}${isCollaborative}` +
              `${description}\n` +
              `**ID**: ${playlist.id}\n` +
              `**URL**: ${url}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting playlist: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
});

const updatePlaylist = defineTool({
  name: 'updatePlaylist',
  description:
    'Update the details of a Spotify playlist (name, description, public/private, collaborative)',
  schema: {
    playlistId: playlistParam,
    name: z.string().optional().describe('New name for the playlist'),
    description: z
      .string()
      .optional()
      .describe('New description for the playlist'),
    public: z
      .boolean()
      .optional()
      .describe('Whether the playlist should be public'),
    collaborative: z
      .boolean()
      .optional()
      .describe(
        'Whether the playlist should be collaborative (requires public to be false)',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const {
      playlistId: playlistRef,
      name,
      description,
      public: isPublic,
      collaborative,
    } = args;

    if (
      !name &&
      description === undefined &&
      isPublic === undefined &&
      collaborative === undefined
    ) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: At least one field to update must be provided (name, description, public, collaborative)',
          },
        ],
      };
    }

    try {
      const playlistId = await playlistIdFrom(playlistRef);
      const body: Record<string, string | boolean> = {};
      if (name) body.name = name;
      if (description !== undefined) body.description = description;
      if (isPublic !== undefined) body.public = isPublic;
      if (collaborative !== undefined) body.collaborative = collaborative;

      await handleSpotifyRequest(async (spotifyApi) => {
        await spotifyApi.playlists.changePlaylistDetails(playlistId, body);
      });

      const changes = Object.keys(body).join(', ');
      return {
        content: [
          {
            type: 'text',
            text: `Successfully updated playlist (ID: ${playlistId})\nFields updated: ${changes}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error updating playlist: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
});

const removeTracksFromPlaylist = defineTool({
  name: 'removeTracksFromPlaylist',
  description:
    'Remove tracks from a Spotify playlist by ID or URI. Any number of IDs is fine, chunking is handled internally.',
  schema: {
    playlistId: playlistParam,
    trackIds: z
      .array(z.string())
      .min(1)
      .max(MAX_BULK_IDS)
      .describe(
        `Array of Spotify track IDs or URIs to remove (1-${MAX_BULK_IDS})`,
      ),
    snapshotId: z
      .string()
      .optional()
      .describe(
        'The playlist snapshot ID to target a specific version (optional, applied to the first request only)',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { playlistId: playlistRef, trackIds, snapshotId } = args;
    const uris = trackIds.map((id) =>
      id.startsWith('spotify:') ? id : `spotify:track:${id}`,
    );
    let playlistId: string;
    try {
      playlistId = await playlistIdFrom(playlistRef);
    } catch (error) {
      return toolError('removing tracks from playlist', error);
    }

    // Hit /items directly: SDK targets the deprecated /tracks endpoint
    // (see spotifyFetch JSDoc for context on the March 2026 migration).
    const { processed, error } = await processInChunks(
      uris,
      100,
      (part, start) =>
        spotifyFetch(`playlists/${playlistId}/items`, {
          method: 'DELETE',
          body: {
            items: part.map((uri) => ({ uri })),
            ...(snapshotId && start === 0 ? { snapshot_id: snapshotId } : {}),
          },
        }),
    );
    if (error) {
      return partialFailure(
        'removing tracks from playlist',
        processed,
        uris.length,
        error,
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `Successfully removed ${processed} track${
            processed === 1 ? '' : 's'
          } from playlist (ID: ${playlistId})`,
        },
      ],
    };
  },
});

const reorderPlaylistItems = defineTool({
  name: 'reorderPlaylistItems',
  description:
    'Reorder a range of tracks within a Spotify playlist by moving them to a new position',
  schema: {
    playlistId: playlistParam,
    rangeStart: z
      .number()
      .nonnegative()
      .describe('The position of the first item to move (0-based index)'),
    insertBefore: z
      .number()
      .nonnegative()
      .describe(
        'The position where the items should be inserted (0-based index)',
      ),
    rangeLength: z
      .number()
      .min(1)
      .optional()
      .describe('Number of consecutive items to move (defaults to 1)'),
    snapshotId: z
      .string()
      .optional()
      .describe(
        'The playlist snapshot ID to target a specific version (optional)',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const {
      playlistId: playlistRef,
      rangeStart,
      insertBefore,
      rangeLength,
      snapshotId,
    } = args;

    try {
      const playlistId = await playlistIdFrom(playlistRef);
      // Hit /items directly: see spotifyFetch JSDoc for context.
      await spotifyFetch(`playlists/${playlistId}/items`, {
        method: 'PUT',
        body: {
          range_start: rangeStart,
          insert_before: insertBefore,
          ...(rangeLength !== undefined ? { range_length: rangeLength } : {}),
          ...(snapshotId ? { snapshot_id: snapshotId } : {}),
        },
        // Positional: replaying a move that already happened moves other items.
        retryGatewayErrors: false,
      });

      const count = rangeLength ?? 1;
      return {
        content: [
          {
            type: 'text',
            text: `Successfully moved ${count} track${
              count === 1 ? '' : 's'
            } from position ${rangeStart} to before position ${insertBefore} in playlist (ID: ${playlistId})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error reordering playlist items: ${
              error instanceof Error ? error.message : String(error)
            }${
              isGatewayError(error)
                ? '\nThe reorder may already have been applied. Check the playlist order before retrying.'
                : ''
            }`,
          },
        ],
      };
    }
  },
});

const unfollowPlaylist = defineTool({
  name: 'unfollowPlaylist',
  description:
    "Remove a playlist from the current user's library (unfollow). " +
    'Note: Spotify does not allow permanent deletion of playlists via the API.',
  schema: {
    playlistId: z
      .string()
      .describe(
        'The playlist to unfollow, by Spotify ID or by name (case-insensitive)',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { playlistId: playlistRef } = args;

    try {
      const playlistId = await playlistIdFrom(playlistRef);
      await spotifyFetch(`playlists/${playlistId}/followers`, {
        method: 'DELETE',
      });

      return {
        content: [
          {
            type: 'text',
            text: `Successfully unfollowed playlist (ID: ${playlistId})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error unfollowing playlist: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
});

const uploadPlaylistCover = defineTool({
  name: 'uploadPlaylistCover',
  description:
    'Set the cover image of a Spotify playlist from a local file path or an http(s) URL. ' +
    'The image must be a JPEG of at most about 190 KB (Spotify caps the base64 payload at 256 KB); ' +
    'a square image of 300-640 px works best. Spotify may take a moment to show the new cover.',
  schema: {
    playlistId: playlistParam,
    image: z
      .string()
      .min(1)
      .describe('Absolute path to a local JPEG file, or an http(s) URL of one'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { playlistId: playlistRef, image } = args;
    try {
      const bytes = await loadCoverImage(image);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        throw new Error(
          'The image is not a JPEG. Spotify only accepts JPEG covers; convert it first.',
        );
      }
      const data = bytes.toString('base64');
      if (data.length > MAX_COVER_BASE64_BYTES) {
        throw new Error(
          `The image is too large: ${Math.ceil(data.length / 1024)} KB as base64, Spotify allows 256 KB. ` +
            'Resize or recompress it (a 640x640 JPEG at quality 85 is usually well below the limit).',
        );
      }

      const playlistId = await playlistIdFrom(playlistRef);
      try {
        await spotifyFetch(`playlists/${playlistId}/images`, {
          method: 'PUT',
          rawBody: { data, contentType: 'image/jpeg' },
        });
      } catch (error) {
        if (
          error instanceof SpotifyApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          throw new Error(
            `${error.message}\nUploading covers needs the "ugc-image-upload" scope. ` +
              'Run "npm run auth" once to grant it.',
          );
        }
        throw error;
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully set the playlist cover (ID: ${playlistId}, ${Math.round(bytes.length / 1024)} KB JPEG). It may take a few seconds to appear in Spotify.`,
          },
        ],
      };
    } catch (error) {
      return toolError('uploading playlist cover', error);
    }
  },
});

export const playlistTools = [
  getPlaylist,
  updatePlaylist,
  removeTracksFromPlaylist,
  reorderPlaylistItems,
  unfollowPlaylist,
  uploadPlaylistCover,
];
