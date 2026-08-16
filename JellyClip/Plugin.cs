// SPDX-FileCopyrightText: 2026 JellyClip contributors
// SPDX-License-Identifier: GPL-3.0-only

using JellyClip.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;

namespace JellyClip;

/// <summary>
/// JellyClip plugin. Lets the user select a start and end point in a video that is currently
/// playing in the Jellyfin web client and download the resulting clip.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// Gets the plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    /// <param name="applicationPaths">Instance of the <see cref="IApplicationPaths"/> interface.</param>
    /// <param name="xmlSerializer">Instance of the <see cref="IXmlSerializer"/> interface.</param>
    /// <param name="logger">Logger.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer, ILogger<Plugin> logger)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <inheritdoc />
    public override string Name => "JellyClip";

    /// <inheritdoc />
    public override string Description => "Select a start and end point in the video you are watching and download the clip.";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("6942adc5-8b2f-4a7d-9c3e-51d8e0f6a4b7");

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return
        [
            new PluginPageInfo
            {
                Name = Name,
                EnableInMainMenu = true,
                EmbeddedResourcePath = GetType().Namespace + ".Configuration.configPage.html"
            },
            new PluginPageInfo
            {
                Name = "jellyclip.js",
                EmbeddedResourcePath = GetType().Namespace + ".Configuration.jellyclip.js"
            },
            new PluginPageInfo
            {
                Name = "jellyclip.css",
                EmbeddedResourcePath = GetType().Namespace + ".Configuration.jellyclip.css"
            }
        ];
    }
}