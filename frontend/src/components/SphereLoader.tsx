import { useEffect, useRef } from 'react'

declare global {
  interface Window {
    THREE: any
  }
}

export default function SphereLoader() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationFrameRef = useRef<number | null>(null)
  const sceneRef = useRef<any>(null)
  const pointsRef = useRef<any>(null)
  const geometryRef = useRef<any>(null)

  useEffect(() => {
    let mounted = true

    function initSphere() {
      if (!mounted || !canvasRef.current) return
      
      const THREE = window.THREE
      if (!THREE) {
        // Three.js가 아직 로드되지 않았으면 재시도
        setTimeout(initSphere, 100)
        return
      }

      const canvas = canvasRef.current
      const width = 220
      const height = 220

      // Config
      const CONFIG = {
        pointCount: 120,
        radius: 2.2,
        rotationSpeed: 0.003,
        bounceIntensity: 0.4,
        bounceSpeed: 2.5,
        pointSize: 0.12,
        colorBright: 0xffffff,
        colorMid: 0x888888,
        colorDark: 0x333333,
      }

      // Scene
      const scene = new THREE.Scene()
      sceneRef.current = scene

      // Camera
      const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000)
      camera.position.z = 7

      // Renderer
      const renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        alpha: true,
      })
      renderer.setSize(width, height)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

      // 구체 점 생성
      const positions: number[] = []
      const colors: number[] = []
      const originalPositions: number[] = []
      const bouncePhases: number[] = []

      const goldenRatio = (1 + Math.sqrt(5)) / 2
      const angleIncrement = Math.PI * 2 * goldenRatio

      const colorBright = new THREE.Color(CONFIG.colorBright)
      const colorMid = new THREE.Color(CONFIG.colorMid)
      const colorDark = new THREE.Color(CONFIG.colorDark)

      for (let i = 0; i < CONFIG.pointCount; i++) {
        const t = i / CONFIG.pointCount
        const inclination = Math.acos(1 - 2 * t)
        const azimuth = angleIncrement * i

        const x = CONFIG.radius * Math.sin(inclination) * Math.cos(azimuth)
        const y = CONFIG.radius * Math.sin(inclination) * Math.sin(azimuth)
        const z = CONFIG.radius * Math.cos(inclination)

        positions.push(x, y, z)
        originalPositions.push(x, y, z)
        bouncePhases.push(Math.random() * Math.PI * 2)

        // 모노톤 그라데이션
        const heightFactor = (y / CONFIG.radius + 1) / 2
        const depthFactor = (z / CONFIG.radius + 1) / 2

        let color
        if (heightFactor > 0.6) {
          color = colorBright.clone().lerp(colorMid, 1 - heightFactor)
        } else if (heightFactor > 0.3) {
          color = colorMid.clone()
        } else {
          color = colorMid.clone().lerp(colorDark, 1 - heightFactor * 2)
        }

        const brightness = 0.5 + depthFactor * 0.5
        color.multiplyScalar(brightness)

        colors.push(color.r, color.g, color.b)
      }

      // Geometry
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
      geometryRef.current = { geometry, originalPositions, bouncePhases, config: CONFIG }

      // Material
      const material = new THREE.PointsMaterial({
        size: CONFIG.pointSize,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: true,
      })

      // Points
      const points = new THREE.Points(geometry, material)
      scene.add(points)
      pointsRef.current = points

      // 애니메이션
      const startTime = Date.now()

      function animate() {
        animationFrameRef.current = requestAnimationFrame(animate)

        const time = (Date.now() - startTime) * 0.001

        // 구체 회전
        points.rotation.y += CONFIG.rotationSpeed
        points.rotation.x = Math.sin(time * 0.3) * 0.15

        // 튀어오르기 애니메이션
        const posArray = geometry.attributes.position.array

        for (let i = 0; i < CONFIG.pointCount; i++) {
          const idx = i * 3
          const ox = originalPositions[idx]
          const oy = originalPositions[idx + 1]
          const oz = originalPositions[idx + 2]

          const phase = bouncePhases[i]
          const bounceTime = time * CONFIG.bounceSpeed + phase

          const bounce = Math.sin(bounceTime) * CONFIG.bounceIntensity

          const dist = Math.sqrt(ox * ox + oy * oy + oz * oz)
          const nx = ox / dist
          const ny = oy / dist
          const nz = oz / dist

          posArray[idx] = ox + nx * bounce
          posArray[idx + 1] = oy + ny * bounce
          posArray[idx + 2] = oz + nz * bounce
        }

        geometry.attributes.position.needsUpdate = true

        // 렌더링
        renderer.render(scene, camera)

      }

      animate()
    }

    // Three.js CDN 로드
    if (!window.THREE) {
      const script = document.createElement('script')
      script.src = 'https://cdn.jsdelivr.net/npm/three@0.153.0/build/three.min.js'
      script.async = true
      script.onload = () => {
        if (mounted) initSphere()
      }
      document.head.appendChild(script)
    } else {
      initSphere()
    }

    return () => {
      mounted = false
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      // Cleanup Three.js resources
      if (geometryRef.current?.geometry) {
        geometryRef.current.geometry.dispose()
      }
      if (pointsRef.current?.material) {
        pointsRef.current.material.dispose()
      }
    }
  }, [])

  return (
    <div className="flex flex-col items-center justify-center">
      {/* Canvas Wrapper */}
      <div className="w-[220px] h-[220px] relative">
        <canvas
          ref={canvasRef}
          width={220}
          height={220}
          className="rounded-full"
        />
      </div>
    </div>
  )
}
