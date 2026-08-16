// SPDX-FileCopyrightText: 2026 JellyClip contributors
// SPDX-License-Identifier: GPL-3.0-only

using JellyClip.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace JellyClip.Services;

/// <summary>
/// Injects and removes the JellyClip UI tags around the web client lifecycle.
/// </summary>
public sealed class WebUiInjectionService : IHostedService
{
    private readonly WebUiService _webUi;
    private readonly ILogger<WebUiInjectionService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="WebUiInjectionService"/> class.
    /// </summary>
    /// <param name="webUi">The web UI injection service.</param>
    /// <param name="logger">Logger.</param>
    public WebUiInjectionService(WebUiService webUi, ILogger<WebUiInjectionService> logger)
    {
        _webUi = webUi;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (!(Plugin.Instance?.Configuration.EnableWebUiInjection ?? false))
        {
            return Task.CompletedTask;
        }

        try
        {
            _webUi.Inject();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to inject JellyClip UI into the web client");
        }

        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        if (!(Plugin.Instance?.Configuration.RemoveWebUiOnShutdown ?? false))
        {
            return Task.CompletedTask;
        }

        try
        {
            _webUi.Remove();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to remove JellyClip UI from the web client");
        }

        return Task.CompletedTask;
    }
}
