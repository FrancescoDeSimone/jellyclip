// SPDX-FileCopyrightText: 2026 JellyClip contributors
// SPDX-License-Identifier: GPL-3.0-only

using System.Globalization;
using JellyClip.Services;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace JellyClip.Controllers;

/// <summary>
/// API for JellyClip: clip generation and web UI injection management.
/// </summary>
[ApiController]
[Route("JellyClip")]
public sealed class JellyClipController : ControllerBase
{
    private readonly ClipService _clipService;
    private readonly WebUiService _webUi;
    private readonly ILogger<JellyClipController> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="JellyClipController"/> class.
    /// </summary>
    /// <param name="clipService">Clip generation service.</param>
    /// <param name="webUi">Web UI injection service.</param>
    /// <param name="logger">Logger.</param>
    public JellyClipController(ClipService clipService, WebUiService webUi, ILogger<JellyClipController> logger)
    {
        _clipService = clipService;
        _webUi = webUi;
        _logger = logger;
    }

    /// <summary>
    /// Generates and downloads a clip from the given item between start and end seconds.
    /// </summary>
    /// <param name="itemId">Identifier of the video item to clip.</param>
    /// <param name="startSeconds">Clip start in seconds.</param>
    /// <param name="endSeconds">Clip end in seconds.</param>
    /// <param name="audioStreamIndex">Absolute audio stream index, or <c>null</c> for the default audio track.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">Clip generated.</response>
    /// <response code="400">Invalid item or time range.</response>
    /// <response code="404">Item not found.</response>
    [HttpGet("{itemId}")]
    [Authorize(Policy = Policies.Download)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> GetClip(string itemId, double startSeconds, double endSeconds, int? audioStreamIndex, CancellationToken cancellationToken)
    {
        _logger.LogInformation("Clip requested: item {ItemId}, start {StartSeconds}s, end {EndSeconds}s, audio {AudioStreamIndex}", itemId, startSeconds, endSeconds, audioStreamIndex);

        if (!TryValidateRange(startSeconds, endSeconds, out string rangeError))
        {
            return BadRequest(rangeError);
        }

        if (!_clipService.TryResolveVideo(itemId, out Video? video, out string resolveError))
        {
            return NotFound(resolveError);
        }

        if (!IsValidAudioStream(video, audioStreamIndex, out string audioError))
        {
            return BadRequest(audioError);
        }

        try
        {
            string clipPath = await _clipService.CreateClipAsync(video, startSeconds, endSeconds, audioStreamIndex, cancellationToken).ConfigureAwait(false);
            string fileName = Path.GetFileName(clipPath);

            // Remove the clip once it has been streamed to the client.
            HttpContext.Response.OnCompleted(() =>
            {
                ClipService.TryDeleteFile(clipPath);
                return Task.CompletedTask;
            });

            return PhysicalFile(clipPath, "video/mp4", fileName, enableRangeProcessing: true);
        }
        catch (ClipException ex)
        {
            _logger.LogWarning(ex, "Failed to create clip for item {ItemId}", itemId);
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Creates a clip for the given item between start and end seconds, returning its
    /// cached filename without streaming the body. The browser then downloads it via
    /// <c>GET JellyClip/clips/{filename}</c> (a native download that auto-starts).
    /// </summary>
    /// <param name="itemId">Identifier of the video item to clip.</param>
    /// <param name="startSeconds">Clip start in seconds.</param>
    /// <param name="endSeconds">Clip end in seconds.</param>
    /// <param name="audioStreamIndex">Absolute audio stream index, or <c>null</c> for the default audio track.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">Clip created.</response>
    /// <response code="400">Invalid item or time range.</response>
    /// <response code="404">Item not found.</response>
    [HttpPost("{itemId}")]
    [Authorize(Policy = Policies.Download)]
    public async Task<ActionResult> CreateClip(string itemId, double startSeconds, double endSeconds, int? audioStreamIndex, CancellationToken cancellationToken)
    {
        _logger.LogInformation("Clip create requested: item {ItemId}, start {StartSeconds}s, end {EndSeconds}s, audio {AudioStreamIndex}", itemId, startSeconds, endSeconds, audioStreamIndex);

        if (!TryValidateRange(startSeconds, endSeconds, out string rangeError))
        {
            return BadRequest(rangeError);
        }

        if (!_clipService.TryResolveVideo(itemId, out Video? video, out string resolveError))
        {
            return NotFound(resolveError);
        }

        if (!IsValidAudioStream(video, audioStreamIndex, out string audioError))
        {
            return BadRequest(audioError);
        }

        try
        {
            string clipPath = await _clipService.CreateClipAsync(video, startSeconds, endSeconds, audioStreamIndex, cancellationToken).ConfigureAwait(false);
            var info = new FileInfo(clipPath);
            return Ok(new { filename = Path.GetFileName(clipPath), size = info.Length });
        }
        catch (ClipException ex)
        {
            _logger.LogWarning(ex, "Failed to create clip for item {ItemId}", itemId);
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Streams a previously created clip as a download, deleting it once sent.
    /// </summary>
    /// <param name="filename">Clip filename as returned by <c>CreateClip</c>.</param>
    /// <response code="200">Clip streamed.</response>
    /// <response code="400">Invalid filename.</response>
    /// <response code="404">Clip not found.</response>
    [HttpGet("clips/{filename}")]
    [Authorize(Policy = Policies.Download)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult DownloadClip(string filename)
    {
        string safe = Path.GetFileName(filename);
        if (!string.Equals(safe, filename, StringComparison.Ordinal))
        {
            return BadRequest("Invalid clip filename.");
        }

        string path = Path.Combine(_clipService.ClipDirectory, safe);
        if (!System.IO.File.Exists(path))
        {
            return NotFound("This clip is no longer available - create it again.");
        }

        HttpContext.Response.OnCompleted(() =>
        {
            ClipService.TryDeleteFile(path);
            return Task.CompletedTask;
        });

        return PhysicalFile(path, "video/mp4", safe, enableRangeProcessing: true);
    }

    /// <summary>
    /// Injects the JellyClip UI tags into the web client.
    /// </summary>
    /// <response code="200">Tags were injected or already present.</response>
    [HttpPost("Inject")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public ActionResult Inject()
    {
        try
        {
            _webUi.Inject();
            return Ok();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to inject JellyClip UI");
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Removes the JellyClip UI tags from the web client.
    /// </summary>
    /// <response code="200">Tags were removed or already absent.</response>
    [HttpPost("Remove")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public ActionResult Remove()
    {
        try
        {
            _webUi.Remove();
            return Ok();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to remove JellyClip UI");
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Reports the current injection state of the web client.
    /// </summary>
    /// <response code="200">Injection state.</response>
    [HttpGet("Status")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public ActionResult<object> Status()
    {
        return Ok(new
        {
            injected = _webUi.IsInjected(),
            webIndexPath = _webUi.WebIndexPath,
            webIndexExists = System.IO.File.Exists(_webUi.WebIndexPath)
        });
    }

    private static bool TryValidateRange(double start, double end, out string error)
    {
        error = string.Empty;

        if (double.IsNaN(start) || double.IsInfinity(start) || double.IsNaN(end) || double.IsInfinity(end))
        {
            error = "Invalid time range.";
            return false;
        }

        if (start < 0 || end <= start)
        {
            error = "The end time must be after the start time, and both must be non-negative.";
            return false;
        }

        return true;
    }

    private static bool IsValidAudioStream(Video video, int? audioStreamIndex, out string error)
    {
        error = string.Empty;

        if (audioStreamIndex is null)
        {
            return true;
        }

        if (!video.GetMediaStreams().Any(m => m.Type == MediaStreamType.Audio && m.Index == audioStreamIndex.Value))
        {
            error = "The selected audio track was not found.";
            return false;
        }

        return true;
    }
}
