# Updated by .github/workflows/release.yml when a v* tag is pushed.
class ComputerUseBridge < Formula
  desc "Use ChatGPT's Codex computer use from any MCP client over your tailnet"
  homepage "https://github.com/hank-warren/computer-use-bridge"
  url "https://github.com/hank-warren/computer-use-bridge/archive/refs/tags/v0.3.0.tar.gz"
  sha256 "857b520a5b31206b18a2ba0f7d805d7fbd567c352ceb3b01a80971b2c581f37a"
  license "MIT"
  head "https://github.com/hank-warren/computer-use-bridge.git", branch: "main"

  depends_on :macos

  def install
    libexec.install "computer-use-bridge.mjs"
    # Runs on ChatGPT.app's bundled Node, which every Mac with Codex computer use has.
    (bin/"computer-use-bridge").write <<~SH
      #!/bin/bash
      NODE="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
      if [[ ! -x "$NODE" ]]; then
        echo "computer-use-bridge: ChatGPT.app with Codex computer use is required ($NODE not found)" >&2
        exit 1
      fi
      exec "$NODE" "#{opt_libexec}/computer-use-bridge.mjs" "$@"
    SH
  end

  def caveats
    <<~EOS
      Requires ChatGPT.app with Computer Use set up in Codex.
      Configure the server and start it:
        computer-use-bridge setup
      Upgrade and restart the service in one step:
        computer-use-bridge update
    EOS
  end

  service do
    run [opt_bin/"computer-use-bridge", "serve"]
    keep_alive true
    process_type :interactive
    log_path var/"log/computer-use-bridge.log"
    error_log_path var/"log/computer-use-bridge.log"
  end

  test do
    assert_path_exists libexec/"computer-use-bridge.mjs"
    if File.exist?("/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node")
      assert_match version.to_s, shell_output("#{bin}/computer-use-bridge --version")
    end
  end
end
