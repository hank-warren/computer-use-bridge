# Deprecated: 1.0 moved to npm (npm i -g computer-use-bridge). Kept at 0.6.0 for existing installs.
class ComputerUseBridge < Formula
  desc "Let MCP clients use your Mac's apps and browser tabs over your tailnet"
  homepage "https://github.com/hank-warren/computer-use-bridge"
  url "https://github.com/hank-warren/computer-use-bridge/archive/refs/tags/v0.6.0.tar.gz"
  sha256 "fba46f4ee3d0967669bc052fe5eadd7314c7f2d7dd6782c8c42bf55fbdce0347"
  license "MIT"

  deprecate! date: "2026-11-01", because: "moved to npm: npm i -g computer-use-bridge"

  depends_on :macos
  depends_on "node"

  def install
    libexec.install "computer-use-bridge.mjs"
    (bin/"computer-use-bridge").write <<~SH
      #!/bin/bash
      exec "#{formula_opt_bin("node")}/node" "#{opt_libexec}/computer-use-bridge.mjs" "$@"
    SH
  end

  def caveats
    <<~EOS
      computer-use-bridge 1.0 and later install with npm, on macOS and Linux:
        npm i -g computer-use-bridge
        computer-use-bridge setup
      setup converts this install's config, keeps its token and replaces this service.
    EOS
  end

  service do
    run [opt_bin/"computer-use-bridge", "serve"]
    keep_alive true
    environment_variables PATH: std_service_path_env
    process_type :interactive
    log_path var/"log/computer-use-bridge.log"
    error_log_path var/"log/computer-use-bridge.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/computer-use-bridge --version")
  end
end
