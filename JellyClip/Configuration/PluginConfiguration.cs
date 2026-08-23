// SPDX-FileCopyrightText: 2026 JellyClip contributors
// SPDX-License-Identifier: GPL-3.0-only

using MediaBrowser.Model.Plugins;

namespace JellyClip.Configuration;

/// <summary>
/// Plugin configuration for JellyClip.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets a value indicating whether the clip UI should be injected into the
    /// Jellyfin web client automatically when the server starts.
    /// </summary>
    public bool EnableWebUiInjection { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether the injected clip UI tags should be removed
    /// from the web client when the server shuts down.
    /// </summary>
    public bool RemoveWebUiOnShutdown { get; set; } = true;

    /// <summary>
    /// Gets or sets the optional custom ffmpeg argument template used to encode clips.
    /// Leave empty to use the built-in defaults. Two placeholders are supported:
    /// <c>{START}</c> and <c>{DURATION}</c> (input, audio map and output are appended).
    /// </summary>
    public string FfmpegArgumentsTemplate { get; set; } = string.Empty;
}
