// SPDX-FileCopyrightText: 2026 JellyClip contributors
// SPDX-License-Identifier: GPL-3.0-only

using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace JellyClip.Services;

/// <summary>
/// Exception thrown when a clip cannot be produced.
/// </summary>
public sealed class ClipException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ClipException"/> class.
    /// </summary>
    /// <param name="message">Human readable failure reason.</param>
    public ClipException(string message)
        : base(message)
    {
    }
}

/// <summary>
/// Uses ffmpeg to cut a clip from a library item.
/// </summary>
public sealed class ClipService
{
    private static readonly TimeSpan ClipRetention = TimeSpan.FromHours(24);

    private readonly ILibraryManager _libraryManager;
    private readonly IApplicationPaths _applicationPaths;
    private readonly IServerConfigurationManager _serverConfigurationManager;
    private readonly ILogger<ClipService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="ClipService"/> class.
    /// </summary>
    /// <param name="libraryManager">Jellyfin library manager.</param>
    /// <param name="applicationPaths">Server application paths.</param>
    /// <param name="serverConfiguration">Server configuration manager.</param>
    /// <param name="logger">Logger.</param>
    public ClipService(
        ILibraryManager libraryManager,
        IApplicationPaths applicationPaths,
        IServerConfigurationManager serverConfiguration,
        ILogger<ClipService> logger)
    {
        _libraryManager = libraryManager;
        _applicationPaths = applicationPaths;
        _serverConfigurationManager = serverConfiguration;
        _logger = logger;
    }

    /// <summary>
    /// Gets the directory where generated clips are staged before being served.
    /// </summary>
    public string ClipDirectory
    {
        get
        {
            string dir = Path.Combine(_applicationPaths.CachePath, "jellyclip");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    /// <summary>
    /// Resolves a library item by identifier.
    /// </summary>
    /// <param name="itemId">The library item identifier.</param>
    /// <param name="video">The resolved video item, or <c>null</c> when <c>false</c>.</param>
    /// <param name="error">A user readable error when resolution failed.</param>
    /// <returns><c>true</c> if the item is a clip-able video, otherwise <c>false</c>.</returns>
    public bool TryResolveVideo(string itemId, [NotNullWhen(true)] out Video? video, out string error)
    {
        video = null;
        error = string.Empty;

        if (!Guid.TryParse(itemId, out Guid id))
        {
            error = "Invalid item id.";
            return false;
        }

        BaseItem? item = _libraryManager.GetItemById(id);
        if (item is not Video resolved)
        {
            error = "The selected item is not a video.";
            return false;
        }

        if (string.IsNullOrWhiteSpace(resolved.Path))
        {
            error = "The item has no playable file path.";
            return false;
        }

        if (Directory.Exists(resolved.Path))
        {
            // Disc-style folders are not directly cut-able by ffmpeg here.
            error = "Clips from disc-style folders are not supported.";
            return false;
        }

        video = resolved;
        return true;
    }

    /// <summary>
    /// Creates a clip from <paramref name="video"/> between <paramref name="start"/> and
    /// <paramref name="end"/> seconds. If a matching clip already exists in the cache it is
    /// reused instead of re-cutting (files are deleted after download, so this stays small).
    /// </summary>
    /// <param name="video">The source video item.</param>
    /// <param name="start">Clip start offset in seconds.</param>
    /// <param name="end">Clip end offset in seconds.</param>
    /// <param name="cancellationToken">Cancellation token (client abort kills ffmpeg).</param>
    /// <returns>Absolute path to the generated clip file.</returns>
    /// <exception cref="ClipException">Thrown when the clip could not be generated.</exception>
    public async Task<string> CreateClipAsync(Video video, double start, double end, CancellationToken cancellationToken)
    {
        PruneOldClips();

        string outputPath = GetClipPath(video, start, end);
        if (File.Exists(outputPath))
        {
            // Cached clip (not yet downloaded or deleted): reuse it.
            return outputPath;
        }

        try
        {
            await RunFfmpegAsync(
                BuildArguments(video.Path, outputPath, start, end),
                cancellationToken).ConfigureAwait(false);

            if (!File.Exists(outputPath))
            {
                throw new ClipException("ffmpeg finished without producing a clip file.");
            }
        }
        catch (ClipException)
        {
            TryDelete(outputPath);
            throw;
        }
        catch (OperationCanceledException)
        {
            TryDelete(outputPath);
            throw;
        }
        catch (Exception ex)
        {
            TryDelete(outputPath);
            throw new ClipException("ffmpeg failed: " + ex.Message);
        }

        return outputPath;
    }

    /// <summary>
    /// Gets the deterministic cache path for a clip, derived from item name and range.
    /// </summary>
    /// <param name="video">The source video item.</param>
    /// <param name="start">Clip start offset in seconds.</param>
    /// <param name="end">Clip end offset in seconds.</param>
    /// <returns>Absolute cache path for the clip.</returns>
    public string GetClipPath(Video video, double start, double end)
    {
        string safeName = SanitizeFileName(video.Name);
        string range = $"{FormatTime(start)}-{FormatTime(end)}";
        return Path.Combine(ClipDirectory, $"{safeName} - {range}.mp4");
    }

    /// <summary>
    /// Best-effort deletion of a file (used after it has been streamed to a client).
    /// </summary>
    /// <param name="path">Absolute path of the file to delete.</param>
    public static void TryDeleteFile(string path) => TryDelete(path);

    private async Task RunFfmpegAsync(string[] arguments, CancellationToken cancellationToken)
    {
        string ffmpegPath = _serverConfigurationManager.GetEncodingOptions().EncoderAppPathDisplay;
        if (string.IsNullOrWhiteSpace(ffmpegPath))
        {
            ffmpegPath = "ffmpeg";
        }

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = ffmpegPath,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
            }
        };

        foreach (string argument in arguments)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }

        using var registration = cancellationToken.Register(() =>
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch (InvalidOperationException)
            {
                // Process already exited.
            }
        });

        _logger.LogInformation("Generating clip: {Ffmpeg} {Arguments}", ffmpegPath, string.Join(' ', arguments));
        process.Start();

        // Drain both pipes concurrently so neither fills up and stalls ffmpeg.
        Task<string> stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        await Task.WhenAll(stderrTask, stdoutTask, process.WaitForExitAsync(cancellationToken)).ConfigureAwait(false);

        cancellationToken.ThrowIfCancellationRequested();

        string? errorOutput = await stderrTask.ConfigureAwait(false);

        if (process.ExitCode != 0)
        {
            string tail = errorOutput is null ? string.Empty : errorOutput[^Math.Min(errorOutput.Length, 2000)..];
            throw new ClipException($"ffmpeg exited with code {process.ExitCode}. {tail}");
        }
    }

    private string[] BuildArguments(string inputPath, string outputPath, double start, double end)
    {
        string startArg = start.ToString("0.###", CultureInfo.InvariantCulture);
        string durationArg = (end - start).ToString("0.###", CultureInfo.InvariantCulture);

        // `-ss` before `-i` seeks fast and is followed by frame-accurate decode;
        // `-t` after `-i` limits the output to the clip duration. Re-encoding is
        // always used because stream copying cannot produce an exact cut: the
        // demuxer seek snaps to the keyframe before `start`.
        var args = new List<string>
        {
            "-hide_banner",
            "-nostdin",
            "-y",
            "-ss", startArg,
            "-t", durationArg,
            "-i", inputPath,
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "19",
            "-c:a", "aac",
            "-b:a", "192k",
            "-movflags", "+faststart",
            outputPath
        };

        return args.ToArray();
    }

    private void PruneOldClips()
    {
        if (!Directory.Exists(ClipDirectory))
        {
            return;
        }

        try
        {
            DateTime cutoff = DateTime.UtcNow - ClipRetention;
            foreach (string file in Directory.EnumerateFiles(ClipDirectory, "*.mp4"))
            {
                if (File.GetLastWriteTimeUtc(file) < cutoff)
                {
                    TryDelete(file);
                }
            }
        }
        catch (IOException ex)
        {
            _logger.LogDebug(ex, "Failed to prune old clips");
        }
    }

    private static string SanitizeFileName(string name)
    {
        char[] invalid = Path.GetInvalidFileNameChars();
        string result = new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray()).Trim();
        return result.Length is > 80 ? result[..80] : result;
    }

    private static string FormatTime(double seconds)
    {
        if (double.IsNaN(seconds) || seconds < 0 || double.IsInfinity(seconds))
        {
            return "0-00-00";
        }

        var span = TimeSpan.FromSeconds(seconds);
        return $"{(int)span.TotalHours:D2}-{span.Minutes:D2}-{span.Seconds:D2}";
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (IOException)
        {
            // Best effort only.
        }
    }
}
