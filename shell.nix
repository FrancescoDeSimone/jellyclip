# Development shell for building the JellyClip plugin.
{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  packages = with pkgs; [
    dotnet-sdk_9
    ffmpeg
  ];
}
