param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out,
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [Parameter(Mandatory=$true)][int]$W,
  [Parameter(Mandatory=$true)][int]$H,
  [int]$Zoom = 3
)

# Crop a region out of a screenshot and blow it up with nearest neighbour.
# Real-machine verification needs exact pixel coordinates for synthetic clicks,
# and the chat-side image viewer downscales full-screen grabs, so this is the
# way to actually measure a button position.
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Bitmap]::FromFile($In)
try {
  $rect = New-Object System.Drawing.Rectangle $X, $Y, $W, $H
  $crop = $src.Clone($rect, $src.PixelFormat)
  try {
    $big = New-Object System.Drawing.Bitmap ($W * $Zoom), ($H * $Zoom)
    try {
      $g = [System.Drawing.Graphics]::FromImage($big)
      try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $g.DrawImage($crop, 0, 0, ($W * $Zoom), ($H * $Zoom))
      } finally { $g.Dispose() }
      $big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $big.Dispose() }
  } finally { $crop.Dispose() }
} finally { $src.Dispose() }

"crop $X,$Y ${W}x$H -> $Out (zoom $Zoom)"
