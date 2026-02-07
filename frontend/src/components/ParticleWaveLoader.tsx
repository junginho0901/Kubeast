import { useEffect, useRef } from 'react'

type ParticleWaveLoaderProps = {
  className?: string
}

declare global {
  interface Window {
    THREE: any
  }
}

export default function ParticleWaveLoader({ className }: ParticleWaveLoaderProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationFrameRef = useRef<number | null>(null)
  const sceneRef = useRef<any>(null)
  const pointsRef = useRef<any>(null)
  const geometryRef = useRef<any>(null)
  const rendererRef = useRef<any>(null)
  const cameraRef = useRef<any>(null)

  useEffect(() => {
    let mounted = true
    let resizeObserver: ResizeObserver | null = null
    let onWindowResize: (() => void) | null = null

    function initParticleWave() {
      if (!mounted || !canvasRef.current || !containerRef.current) return
      
      const THREE = window.THREE
      if (!THREE) {
        setTimeout(initParticleWave, 100)
        return
      }

      const canvas = canvasRef.current
      const width = Math.max(1, Math.floor(containerRef.current.clientWidth))
      const height = Math.max(1, Math.floor(containerRef.current.clientHeight))

      // Config
      const CONFIG = {
        pointCount: 150,
        baseRadius: 2.0,
        waveAmplitude: 0.5,
        waveSpeed: 2.0,
        rotationSpeed: 0.002,
        pointSize: 0.15,
        colorPrimary: 0x60a5fa,  // blue-400
        colorSecondary: 0x8b5cf6, // purple-500
        colorAccent: 0xec4899,   // pink-500
      }

      // Scene
      const scene = new THREE.Scene()
      sceneRef.current = scene

      // Camera
      const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000)
      camera.position.z = 7
      cameraRef.current = camera

      // Renderer
      const renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        alpha: true,
      })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(width, height, false)
      rendererRef.current = renderer

      // 파티클 생성
      const positions: number[] = []
      const colors: number[] = []
      const originalPositions: number[] = []
      const wavePhases: number[] = []

      const goldenRatio = (1 + Math.sqrt(5)) / 2
      const angleIncrement = Math.PI * 2 * goldenRatio

      const colorPrimary = new THREE.Color(CONFIG.colorPrimary)
      const colorSecondary = new THREE.Color(CONFIG.colorSecondary)
      const colorAccent = new THREE.Color(CONFIG.colorAccent)

      for (let i = 0; i < CONFIG.pointCount; i++) {
        const t = i / CONFIG.pointCount
        const inclination = Math.acos(1 - 2 * t)
        const azimuth = angleIncrement * i

        const x = CONFIG.baseRadius * Math.sin(inclination) * Math.cos(azimuth)
        const y = CONFIG.baseRadius * Math.sin(inclination) * Math.sin(azimuth)
        const z = CONFIG.baseRadius * Math.cos(inclination)

        originalPositions.push(x, y, z)
        positions.push(x, y, z)
        wavePhases.push(Math.random() * Math.PI * 2)

        // 그라데이션 색상 (위에서 아래로)
        let color
        const normalizedY = (y / CONFIG.baseRadius + 1) / 2
        
        if (normalizedY > 0.7) {
          color = colorPrimary.clone()
        } else if (normalizedY > 0.4) {
          color = colorSecondary.clone()
        } else {
          color = colorAccent.clone()
        }

        // 깊이에 따른 밝기 조절
        const depthFactor = (z / CONFIG.baseRadius + 1) / 2
        const brightness = 0.6 + depthFactor * 0.4
        color.multiplyScalar(brightness)

        colors.push(color.r, color.g, color.b)
      }

      // Geometry
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
      geometryRef.current = { geometry, originalPositions, wavePhases, config: CONFIG }

      // Material
      const material = new THREE.PointsMaterial({
        size: CONFIG.pointSize,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        sizeAttenuation: true,
      })

      // Points
      const points = new THREE.Points(geometry, material)
      scene.add(points)
      pointsRef.current = points

      // 애니메이션
      const startTime = Date.now()

      function resize() {
        if (!mounted || !containerRef.current || !rendererRef.current || !cameraRef.current) return
        const nextWidth = Math.max(1, Math.floor(containerRef.current.clientWidth))
        const nextHeight = Math.max(1, Math.floor(containerRef.current.clientHeight))
        rendererRef.current.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        rendererRef.current.setSize(nextWidth, nextHeight, false)
        cameraRef.current.aspect = nextWidth / nextHeight
        cameraRef.current.updateProjectionMatrix()
      }

      resize()

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => resize())
        resizeObserver.observe(containerRef.current)
      } else {
        onWindowResize = () => resize()
        window.addEventListener('resize', onWindowResize)
      }

      function animate() {
        if (!mounted) return
        animationFrameRef.current = requestAnimationFrame(animate)

        const time = (Date.now() - startTime) * 0.001

        // 전체 회전
        points.rotation.y += CONFIG.rotationSpeed
        points.rotation.x = Math.sin(time * 0.2) * 0.1

        // 파도 효과
        const posArray = geometry.attributes.position.array
        const { originalPositions, wavePhases, config } = geometryRef.current

        for (let i = 0; i < config.pointCount; i++) {
          const idx = i * 3
          const ox = originalPositions[idx]
          const oy = originalPositions[idx + 1]
          const oz = originalPositions[idx + 2]

          // 파도 효과를 위한 거리 계산
          const phase = wavePhases[i]
          const waveTime = time * config.waveSpeed + phase
          
          // 여러 주파수의 파도 결합
          const wave1 = Math.sin(waveTime) * config.waveAmplitude
          const wave2 = Math.sin(waveTime * 1.5) * config.waveAmplitude * 0.5
          const wave3 = Math.cos(waveTime * 0.7) * config.waveAmplitude * 0.3
          
          const totalWave = wave1 + wave2 + wave3

          // 원점에서의 방향 벡터
          const dist = Math.sqrt(ox * ox + oy * oy + oz * oz)
          const nx = ox / dist
          const ny = oy / dist
          const nz = oz / dist

          // 파도 효과 적용
          posArray[idx] = ox + nx * totalWave
          posArray[idx + 1] = oy + ny * totalWave
          posArray[idx + 2] = oz + nz * totalWave
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
        if (mounted) initParticleWave()
      }
      document.head.appendChild(script)
    } else {
      initParticleWave()
    }

    return () => {
      mounted = false
      if (resizeObserver) {
        resizeObserver.disconnect()
        resizeObserver = null
      }
      if (onWindowResize) {
        window.removeEventListener('resize', onWindowResize)
        onWindowResize = null
      }
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
      if (rendererRef.current) {
        rendererRef.current.dispose?.()
      }
    }
  }, [])

  return (
    <div className="flex flex-col items-center justify-center">
      <div ref={containerRef} className={`${className ?? 'w-[220px] h-[220px]'} relative`}>
        <canvas
          ref={canvasRef}
          className="w-full h-full rounded-full"
        />
      </div>
    </div>
  )
}
