// SPDX-FileCopyrightText: 2026 JellyClip contributors
// SPDX-License-Identifier: GPL-3.0-only

using System.Text;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace JellyClip.Services;

/// <summary>
/// Injects the JellyClip UI tags into the Jellyfin web client's <c>index.html</c>.
/// The browser then fetches <c>jellyclip.js</c> and <c>jellyclip.css</c>, which are served
/// by the Jellyfin dashboard from this plugin's embedded resources.
/// </summary>
public sealed class WebUiService
{
    /// <summary>
    /// Marker that wraps the injected tags so the operation stays idempotent and reversible.
    /// </summary>
    public const string StartMarker = "<!-- JellyClip-Ui:start -->";

    /// <summary>
    /// Closing marker for injected tags.
    /// </summary>
    public const string EndMarker = "<!-- JellyClip-Ui:end -->";

    private const string StyleTag = "<link rel=\"stylesheet\" href=\"configurationpage?name=jellyclip.css\">";
    private const string ScriptTag = "<script src=\"configurationpage?name=jellyclip.js\"></script>";

    /// <summary>
    /// Cache-busting query appended to injected tags so browsers and service
    /// workers fetch the current files after plugin updates. Must match the
    /// tags seeded at build time (see nix-conf jellyfin.nix).
    /// </summary>
    private static string VersionQuery =>
        "?v=" + (typeof(WebUiService).Assembly.GetName().Version?.ToString() ?? "0.0.0.0");

    private static string VersionedTag(string tag)
    {
        int q = tag.IndexOf('?');
        if (q < 0)
        {
            return tag;
        }

        int end = tag.IndexOf('"', q);
        if (end < 0)
        {
            return tag;
        }

        return tag.Substring(0, end) + "&" + VersionQuery.TrimStart('?') + tag.Substring(end);
    }

    private readonly IApplicationPaths _applicationPaths;
    private readonly ILogger<WebUiService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="WebUiService"/> class.
    /// </summary>
    /// <param name="applicationPaths">Server application paths.</param>
    /// <param name="logger">Logger.</param>
    public WebUiService(IApplicationPaths applicationPaths, ILogger<WebUiService> logger)
    {
        _applicationPaths = applicationPaths;
        _logger = logger;
    }

    /// <summary>
    /// Gets the web client's absolute <c>index.html</c> path.
    /// </summary>
    public string WebIndexPath => Path.Combine(_applicationPaths.WebPath, "index.html");

    /// <summary>
    /// Gets a value indicating whether the JellyClip UI tags are currently present in the web client.
    /// </summary>
    /// <returns><c>true</c> if the markers are present, otherwise <c>false</c>.</returns>
    public bool IsInjected()
    {
        if (!File.Exists(WebIndexPath))
        {
            return false;
        }

        return File.ReadAllText(WebIndexPath).Contains(StartMarker, StringComparison.Ordinal);
    }

    /// <summary>
    /// Inserts the JellyClip UI tags into the web client's <c>index.html</c> if they are missing.
    /// </summary>
    /// <returns><c>true</c> if the file was modified, <c>false</c> if it was already injected.</returns>
    /// <exception cref="InvalidOperationException">Thrown when the web client file cannot be located.</exception>
    public bool Inject()
    {
        if (IsInjected())
        {
            return false;
        }

        string path = WebIndexPath;
        if (!File.Exists(path))
        {
            throw new InvalidOperationException($"Web client not found at {path}. Is the server hosting the web client?");
        }

        string html = File.ReadAllText(path);
        RemoveMarkedBlock(ref html);

        string block = string.Join(Environment.NewLine, StartMarker, VersionedTag(StyleTag), VersionedTag(ScriptTag), EndMarker);
        int bodyIndex = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        html = bodyIndex >= 0
            ? html.Insert(bodyIndex, block + Environment.NewLine)
            : html + Environment.NewLine + block;

        try
        {
            File.WriteAllText(path, html, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
        catch (UnauthorizedAccessException ex)
        {
            throw new InvalidOperationException(
                $"The web client directory is not writable: {path}. " +
                "Point Jellyfin at a writable web directory (e.g. --webdir=/var/lib/jellyfin/web) or grant the Jellyfin service user write access.", ex);
        }

        _logger.LogInformation("Injected JellyClip UI tags into {Path}", path);
        return true;
    }

    /// <summary>
    /// Removes the JellyClip UI tags from the web client's <c>index.html</c> if they are present.
    /// </summary>
    /// <returns><c>true</c> if the file was modified, <c>false</c> if there was nothing to remove.</returns>
    public bool Remove()
    {
        string path = WebIndexPath;
        if (!File.Exists(path))
        {
            return false;
        }

        string html = File.ReadAllText(path);
        if (!RemoveMarkedBlock(ref html))
        {
            return false;
        }

        try
        {
            File.WriteAllText(path, html, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
        catch (UnauthorizedAccessException ex)
        {
            // Read-only web client (e.g. baked into the Nix store at build time):
            // removal is intentionally not possible, treat it as no-op.
            _logger.LogInformation(ex, "Web client is read-only ({Path}); leaving JellyClip UI tags in place", path);
            return true;
        }

        _logger.LogInformation("Removed JellyClip UI tags from {Path}", path);
        return true;
    }

    private static bool RemoveMarkedBlock(ref string html)
    {
        int start = html.IndexOf(StartMarker, StringComparison.Ordinal);
        int end = html.IndexOf(EndMarker, StringComparison.Ordinal);

        if (start < 0 && end < 0)
        {
            return false;
        }

        if (start < 0 || end < 0 || end < start)
        {
            // Partially present markers: strip each marker line individually to recover.
            html = html.Replace(StartMarker + Environment.NewLine, string.Empty, StringComparison.Ordinal)
                .Replace(Environment.NewLine + StartMarker, string.Empty, StringComparison.Ordinal)
                .Replace(StartMarker, string.Empty, StringComparison.Ordinal)
                .Replace(EndMarker + Environment.NewLine, string.Empty, StringComparison.Ordinal)
                .Replace(Environment.NewLine + EndMarker, string.Empty, StringComparison.Ordinal)
                .Replace(EndMarker, string.Empty, StringComparison.Ordinal);
            return true;
        }

        int blockEnd = end + EndMarker.Length;
        // Consume the trailing newline left from the inserted block, if any.
        if (blockEnd < html.Length && html[blockEnd] == '\n')
        {
            blockEnd++;
        }

        html = html.Remove(start, blockEnd - start);
        return true;
    }
}
